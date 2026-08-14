import "server-only";

import { createHash } from "node:crypto";

import sharp from "sharp";

const sampleSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500" viewBox="0 0 1200 1500">
  <rect width="1200" height="1500" fill="#F5EFE3"/>
  <circle cx="995" cy="215" r="260" fill="#E5A76B" opacity="0.78"/>
  <path d="M0 1110 C180 995 315 1005 470 1110 C650 1235 855 1210 1200 980 L1200 1500 L0 1500 Z" fill="#355F55"/>
  <path d="M0 1210 C255 1080 485 1330 715 1190 C885 1085 1030 1115 1200 1210 L1200 1500 L0 1500 Z" fill="#173C37" opacity="0.88"/>
  <rect x="115" y="205" width="970" height="930" rx="54" fill="#FFFDF7" stroke="#173C37" stroke-width="14"/>
  <path d="M230 850 L405 630 L530 745 L710 505 L960 850 Z" fill="#B66A43" opacity="0.92"/>
  <circle cx="370" cy="420" r="92" fill="#EBCB74"/>
  <path d="M250 930 H950" stroke="#173C37" stroke-width="16" stroke-linecap="round"/>
  <path d="M330 1010 H870" stroke="#355F55" stroke-width="12" stroke-linecap="round" opacity="0.7"/>
</svg>`;

export type ReviewerSampleImage = {
  bytes: Uint8Array;
  sha256Hex: string;
  sizeBytes: number;
};

let cachedSample: Promise<ReviewerSampleImage> | undefined;

async function render(): Promise<ReviewerSampleImage> {
  const buffer = await sharp(Buffer.from(sampleSvg), {
    failOn: "error",
    limitInputPixels: 2_000_000,
  })
    .webp({ effort: 6, quality: 86, smartSubsample: true })
    .toBuffer();
  const bytes = new Uint8Array(buffer);
  return {
    bytes,
    sha256Hex: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

/** Rights-safe, metadata-free sample artwork generated only from local vectors. */
export function getReviewerSampleImage(): Promise<ReviewerSampleImage> {
  cachedSample ??= render();
  return cachedSample;
}
