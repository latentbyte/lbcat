import { Server } from "@Packages/message/server";
import type { MessageSend } from "@Packages/message/types";
import { WindowMessage } from "@Packages/message/window_message";
import { ServiceWorkerClient } from "../service_worker/client";
import { BackgroundEnvManagerBase } from "./base";
import type { IMessageQueue } from "@Packages/message/message_queue";

// offscreen环境的管理器
export class OffscreenManager extends BackgroundEnvManagerBase {
  constructor(extMsgSender: MessageSend, messageQueue: IMessageQueue) {
    const windowMessage = new WindowMessage(window, sandbox, true);
    const windowServer = new Server("offscreen", windowMessage);
    const serviceWorker = new ServiceWorkerClient(extMsgSender);
    super(extMsgSender, windowMessage, windowServer, serviceWorker, messageQueue);
  }
}
