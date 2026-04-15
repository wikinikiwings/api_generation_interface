export const DEFAULT_STYLE_ID = "__default__";
export const DEFAULT_STYLE_NAME = "Стандартный";

export const STYLE_NAME_MAX = 80;
export const STYLE_PART_MAX = 2000; // prefix and suffix, each

export interface Style {
  id: string;
  name: string;
  prefix: string;
  suffix: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface StyleCreateInput {
  name: string;
  prefix: string;
  suffix: string;
}

export interface StyleUpdateInput {
  name?: string;
  prefix?: string;
  suffix?: string;
}
