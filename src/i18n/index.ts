import type { Lang } from "../srs/ladder";
import { ru, type Dict } from "./ru";
import { tt } from "./tt";

export const dict = (lang: Lang): Dict => (lang === "ru" ? ru : tt);
export type { Dict };
