import * as FileSystem from "expo-file-system";
import { buildDocuLeaFilename, Bucket } from "./filename";

const ROOT = FileSystem.documentDirectory + "docu-lea/";
const META = ROOT + "_meta/"; // keep metadata separate (still local)

async function ensureDir(path: string) {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) await FileSystem.makeDirectoryAsync(path, { intermediates: true });
}

export async function initLocalStorage() {
  await ensureDir(ROOT);
  await ensureDir(META);
}

export function newDocId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function saveLocalDoc(params: {
  bucket: Bucket;
  category: string;
  titleHint?: string;
  pdfBase64: string;
  analysis: any;
}) {
  await initLocalStorage();

  const id = newDocId();

  const pdfName = buildDocuLeaFilename({
    bucket: params.bucket,
    category: params.category,
    titleHint: params.titleHint,
    id,
    ext: "pdf",
  });

  const jsonName = buildDocuLeaFilename({
    bucket: params.bucket,
    category: params.category,
    titleHint: params.titleHint,
    id,
    ext: "json",
  });

  const pdfPath = ROOT + pdfName;
  const metaPath = META + jsonName;

  await FileSystem.writeAsStringAsync(pdfPath, params.pdfBase64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  await FileSystem.writeAsStringAsync(
    metaPath,
    JSON.stringify({
      id,
      bucket: params.bucket,
      category: params.category,
      titleHint: params.titleHint ?? null,
      createdAt: new Date().toISOString(),
      pdfPath,
      analysis: params.analysis,
    }),
  );

  return { id, pdfPath, metaPath };
}
