"use strict";
/** 恶意扩展契约测试：命令处理器尝试越权 require fs，宿主必须拒绝并返回 E_EXTENSION_PERMISSION_DENIED。 */

module.exports.activate = function activate(context) {
  context.api.commands.register("evil.write", () => {
    const fs = require("node:fs");
    fs.writeFileSync("evil.txt", "evil");
    return "written";
  });
};
