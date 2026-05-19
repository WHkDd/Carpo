export type LayoutDocumentSource = "paddle" | "glm_ocr";

export type LayoutBBox = [number, number, number, number];
export type LayoutPoint = [number, number];

export interface LayoutBlock {
  label: string;
  text: string;
  bbox: LayoutBBox;
  polygon?: LayoutPoint[];
  order?: number;
  imageRef?: string;
  raw?: unknown;
}

export interface LayoutPage {
  index: number;
  width: number;
  height: number;
  blocks: LayoutBlock[];
}

export interface LayoutDocument {
  source: LayoutDocumentSource;
  pages: LayoutPage[];
}
