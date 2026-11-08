"use strict";
/**
 * 扩展宿主：运行在 Electron Utility Process 中。
 * 通过 vm 上下文 + 受限 require 隔离第三方代码：禁止 fs/net/child_process 等模块。
 * 与主进程的 RPC 见 doc/design.md §7.6.3、§7.6.5。
 */
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const util = require("node:util");

let session = null;
const timers = { setTimeout, clearTimeout, setInterval, clearInterval };

function post(message) {
  process.parentPort.postMessage(message);
}

function describe(error) {
  return error && error.message ? error.message : String(error);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function createLogger() {
  const write = (level) => (message) => post({ type: "log", level, message: String(message) });
  return { info: write("info"), warn: write("warn"), error: write("error"), debug: write("debug") };
}

function validateProvider(provider) {
  if (!provider || typeof provider !== "object") throw new Error("registerProvider 需要对象");
  if (typeof provider.id !== "string" || !provider.id) throw new Error("provider.id 缺失");
  if (!Array.isArray(provider.extensions)) throw new Error("provider.extensions 必须是数组");
  if (typeof provider.parse !== "function") throw new Error("provider.parse 必须是函数");
  if (typeof provider.serialize !== "function") throw new Error("provider.serialize 必须是函数");
}

function createApi(settings, logger) {
  const providers = new Map();
  const commands = new Map();
  const languages = [];
  const renderers = new Map();
  const openListeners = [];
  const disposable = (fn) => ({ dispose: fn });
  const api = {
    version: "1",
    schemaVersion: 1,
    formats: {
      registerProvider(provider) {
        validateProvider(provider);
        providers.set(provider.id, provider);
        return disposable(() => providers.delete(provider.id));
      },
    },
    languages: {
      register(definition) {
        if (!definition || typeof definition.id !== "string") throw new Error("语言定义缺少 id");
        languages.push(definition);
        return disposable(() => undefined);
      },
    },
    renderers: {
      register(definition) {
        if (!definition || typeof definition.kind !== "string") throw new Error("渲染器定义缺少 kind");
        renderers.set(definition.kind, definition);
        return disposable(() => renderers.delete(definition.kind));
      },
    },
    commands: {
      register(id, handler) {
        if (typeof id !== "string" || typeof handler !== "function") {
          throw new Error("commands.register 参数不合法");
        }
        commands.set(id, handler);
        return disposable(() => commands.delete(id));
      },
    },
    settings: {
      define(schema) {
        if (!schema || typeof schema !== "object") return disposable(() => undefined);
        for (const [key, definition] of Object.entries(schema)) {
          if (!(key in settings) && definition && typeof definition === "object") {
            settings[key] = definition.default;
          }
        }
        return disposable(() => undefined);
      },
      get(key) {
        return settings[key];
      },
    },
    workspace: {
      onDidOpen(listener) {
        openListeners.push(listener);
        return disposable(() => undefined);
      },
    },
    log: logger,
  };
  return { api, providers, commands, languages, renderers, openListeners };
}

function createLoader(root, context) {
  const cache = new Map();

  function loadModule(file) {
    const resolved = fs.realpathSync(file);
    if (!isInside(root, resolved)) {
      throw new Error(`E_EXTENSION_PERMISSION_DENIED: 文件位于扩展目录之外：${file}`);
    }
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} };
    cache.set(resolved, module);
    const source = fs.readFileSync(resolved, "utf8");
    const factory = new vm.Script(
      `(function (exports, require, module, __filename, __dirname) {\n${source}\n})`,
      { filename: resolved },
    ).runInContext(context);
    factory.call(module.exports, module.exports, makeRequire(resolved), module, resolved, path.dirname(resolved));
    return module.exports;
  }

  function makeRequire(parentFile) {
    return function require(specifier) {
      if (specifier === "path" || specifier === "node:path") return path;
      if (specifier === "util" || specifier === "node:util") return util;
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        throw new Error(`E_EXTENSION_PERMISSION_DENIED: 禁止加载模块 ${specifier}`);
      }
      let target = path.resolve(path.dirname(parentFile), specifier);
      if (!path.extname(target)) target += ".js";
      return loadModule(target);
    };
  }

  return (entry) => loadModule(entry);
}

function deactivate() {
  if (session && typeof session.module.deactivate === "function") {
    try {
      session.module.deactivate();
    } catch {
      // 忽略卸载异常
    }
  }
  session = null;
}

async function handleActivate(message) {
  deactivate();
  const root = fs.realpathSync(message.extensionPath);
  const mainPath = path.resolve(root, message.mainPath);
  if (!isInside(root, mainPath)) throw new Error("扩展入口位于扩展目录之外");

  const logger = createLogger();
  const settings = { ...(message.settings || {}) };
  const context = vm.createContext({
    console: logger,
    ...timers,
  });
  const { api, providers, commands, languages, renderers, openListeners } = createApi(settings, logger);
  const load = createLoader(root, context);
  const module = load(mainPath);

  if (typeof module.activate !== "function") throw new Error("扩展入口必须导出 activate()");
  const activation = {
    extensionId: message.extensionId,
    extensionPath: root,
    api,
    subscriptions: [],
  };
  await Promise.resolve(module.activate(activation));
  session = { root, module, providers, commands, languages, renderers, openListeners };
}

async function handleCall(message) {
  if (!session) throw new Error("扩展尚未激活");
  const payload = message.payload || {};
  switch (message.method) {
    case "parse": {
      const provider = session.providers.get(payload.providerId);
      if (!provider) throw new Error(`未注册的格式 provider：${payload.providerId}`);
      const result = await provider.parse(payload.source, {
        path: payload.path ?? null,
        settings: {},
      });
      if (result && typeof result === "object" && "doc" in result) {
        return { doc: result.doc, diagnostics: result.diagnostics ?? [] };
      }
      return { doc: result, diagnostics: [] };
    }
    case "serialize": {
      const provider = session.providers.get(payload.providerId);
      if (!provider) throw new Error(`未注册的格式 provider：${payload.providerId}`);
      const source = await provider.serialize(payload.doc, { path: payload.path ?? null, settings: {} });
      return { source: String(source ?? "") };
    }
    case "preview": {
      const provider = session.providers.get(payload.providerId);
      if (!provider) throw new Error(`未注册的格式 provider：${payload.providerId}`);
      if (typeof provider.renderPreview !== "function") return { html: "", diagnostics: [] };
      return {
        html: await provider.renderPreview(payload.doc, { theme: "light", path: payload.path ?? null }),
        diagnostics: [],
      };
    }
    case "command": {
      const handler = session.commands.get(payload.id);
      if (!handler) throw new Error(`未注册的命令：${payload.id}`);
      return await handler(payload.args);
    }
    default:
      throw new Error(`未知调用：${message.method}`);
  }
}

process.parentPort.on("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.type === "activate") {
    handleActivate(message)
      .then(() => post({ type: "activated" }))
      .catch((error) => post({ type: "activation-error", message: describe(error) }));
    return;
  }
  if (message.type === "call") {
    handleCall(message)
      .then((data) => post({ type: "result", requestId: message.requestId, data }))
      .catch((error) => post({ type: "call-error", requestId: message.requestId, message: describe(error) }));
  }
});

process.on("uncaughtException", (error) => {
  post({ type: "activation-error", message: `宿主异常：${describe(error)}` });
});
process.on("unhandledRejection", (reason) => {
  post({ type: "activation-error", message: `宿主异常：${describe(reason)}` });
});

post({ type: "ready" });
