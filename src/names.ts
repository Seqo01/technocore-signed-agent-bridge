import { ProtocolError } from "./errors.js";

export const TECHNOCORE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function assertTechnocoreName(value: string, label = "name"): string {
  if (!TECHNOCORE_NAME_PATTERN.test(value)) {
    throw new ProtocolError(
      `${label} must match ^[a-z0-9][a-z0-9_-]{0,47}$`,
    );
  }
  return value;
}

export function assertLocalAlias(value: string, label = "alias"): string {
  return assertTechnocoreName(value, label);
}

export type RoomClass = "p" | "mb" | "d" | "e";
const ROOM_CLASSES = new Set<RoomClass>(["p", "mb", "d", "e"]);

export function roomClasses(room: string): RoomClass[] {
  assertTechnocoreName(room, "room");
  const segments = room.split("-");
  const classes: RoomClass[] = [];
  for (const segment of segments) {
    if (!ROOM_CLASSES.has(segment as RoomClass)) break;
    classes.push(segment as RoomClass);
  }
  return classes;
}

export function assertSignedPrivateMailbox(room: string): string {
  const classes = roomClasses(room);
  if (!classes.includes("mb") || !classes.includes("p")) {
    throw new ProtocolError("mailbox must compose the mb and p room classes");
  }
  return room;
}
