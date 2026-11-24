import { EventEmitter } from "node:events";

/** Tells open photo-wall displays that something changed (a picture arrived, was approved, hidden or deleted). In-process, like the print bus. */
export const wallBus = new EventEmitter();
wallBus.setMaxListeners(0);
export const notifyWall = (eventId: string) => wallBus.emit(eventId);
