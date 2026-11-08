import type { PandaApi } from "./ipc";

declare global {
  interface Window {
    panda: PandaApi;
  }
}

export {};
