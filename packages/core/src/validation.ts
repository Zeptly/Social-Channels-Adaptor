import type { MediaKind, NetworkConstraints } from "@zeptly-social/domain";

export interface MediaFacts {
  id: string;
  kind: MediaKind;
  contentType: string;
  sizeBytes?: number | null;
  status: string;
}

export interface TargetContentFacts {
  text: string;
  media: MediaFacts[];
  options: Record<string, unknown>;
}

/**
 * Validate one target's effective content against the verified network
 * constraints (capability registry). Pure; returns human-readable problems.
 */
export function validateTargetContent(network: string, c: NetworkConstraints, t: TargetContentFacts): string[] {
  const p: string[] = [];
  const text = t.text ?? "";
  if (text.length > c.maxTextLength) p.push(`${network}: text exceeds ${c.maxTextLength} characters`);
  if (c.textRequired && text.trim() === "") p.push(`${network}: text is required`);
  if (text.trim() === "" && t.media.length === 0) p.push(`${network}: content needs text or media`);
  if (c.mediaRequired && t.media.length === 0) p.push(`${network}: at least one media item is required`);
  if (t.media.length > c.maxMediaItems) p.push(`${network}: at most ${c.maxMediaItems} media item(s) allowed`);
  const kinds = new Set(t.media.map((m) => m.kind));
  if (!c.allowMixedMedia && kinds.size > 1) p.push(`${network}: images and videos cannot be mixed`);
  for (const kind of kinds) {
    const kc = c[kind];
    const items = t.media.filter((m) => m.kind === kind);
    if (!kc) {
      p.push(`${network}: ${kind} media is not supported`);
      continue;
    }
    if (items.length > kc.maxItems) p.push(`${network}: at most ${kc.maxItems} ${kind}(s) allowed`);
    for (const m of items) {
      if (!kc.mimeTypes.includes(m.contentType)) p.push(`${network}: media ${m.id} type ${m.contentType} is not accepted`);
      if (kc.maxSizeBytes && m.sizeBytes && m.sizeBytes > kc.maxSizeBytes) p.push(`${network}: media ${m.id} exceeds ${kc.maxSizeBytes} bytes`);
    }
  }
  for (const m of t.media) if (m.status === "failed") p.push(`${network}: media ${m.id} failed processing`);

  const specs = new Map(c.options.map((o) => [o.key, o]));
  for (const key of Object.keys(t.options)) {
    if (!specs.has(key)) p.push(`${network}: option "${key}" is not supported`);
  }
  for (const spec of c.options) {
    const v = t.options[spec.key];
    if (v === undefined || v === null || v === "") {
      if (spec.required) p.push(`${network}: option "${spec.key}" is required`);
      continue;
    }
    switch (spec.type) {
      case "boolean":
        if (typeof v !== "boolean") p.push(`${network}: option "${spec.key}" must be a boolean`);
        break;
      case "enum":
        if (typeof v !== "string" || !(spec.values ?? []).includes(v)) p.push(`${network}: option "${spec.key}" must be one of ${(spec.values ?? []).join(", ")}`);
        break;
      case "string":
        if (typeof v !== "string") p.push(`${network}: option "${spec.key}" must be a string`);
        else if (spec.maxLength && v.length > spec.maxLength) p.push(`${network}: option "${spec.key}" exceeds ${spec.maxLength} characters`);
        break;
      case "string_array":
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) p.push(`${network}: option "${spec.key}" must be an array of strings`);
        break;
    }
  }
  return p;
}
