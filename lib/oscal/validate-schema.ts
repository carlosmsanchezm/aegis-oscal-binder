import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv, { type ValidateFunction, type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { createHash } from "node:crypto";
import { findRepoRoot } from "../aegis/paths";
import { AegisError } from "../aegis/errors";
export const OSCAL_MODELS = {
  "system-security-plan": "ssp",
  "plan-of-action-and-milestones": "poam",
  "assessment-plan": "assessment-plan",
  "assessment-results": "assessment-results",
  catalog: "catalog",
  profile: "profile",
  "component-definition": "component",
} as const;
export type OscalModel = keyof typeof OSCAL_MODELS;
const cache = new Map<string, ValidateFunction>();
export function schemaValidator(
  model: OscalModel,
  root = findRepoRoot(),
): ValidateFunction {
  const filename = `oscal_${OSCAL_MODELS[model]}_schema.json`,
    key = path.join(root, "schemas/oscal/1.1.2", filename),
    cached = cache.get(key);
  if (cached) return cached;
  try {
    const bytes = readFileSync(key),
      pin = JSON.parse(
        readFileSync(
          path.join(root, "schemas/oscal/1.1.2/checksums.json"),
          "utf8",
        ),
      ) as { tag: string; files: { file: string; sha256: string }[] };
    if (
      pin.tag !== "v1.1.2" ||
      createHash("sha256").update(bytes).digest("hex") !==
        pin.files.find((f) => f.file === filename)?.sha256
    )
      throw new Error("Schema checksum mismatch.");
    const ajv = new Ajv({
      allErrors: true,
      strict: false,
      validateSchema: false,
    });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(bytes.toString("utf8")));
    cache.set(key, validate);
    return validate;
  } catch {
    throw new AegisError(
      "SCHEMA_UNAVAILABLE",
      "Pinned OSCAL 1.1.2 schema is unavailable or its checksum differs.",
      503,
    );
  }
}
export function documentModel(document: unknown): OscalModel | null {
  if (!document || typeof document !== "object" || Array.isArray(document))
    return null;
  const models = Object.keys(OSCAL_MODELS).filter((m) =>
    Object.hasOwn(document, m),
  );
  return models.length === 1 ? (models[0] as OscalModel) : null;
}
export function validateSchema(
  document: unknown,
  model: OscalModel | null = documentModel(document),
  root = findRepoRoot(),
): { valid: boolean; model: OscalModel | null; errors: ErrorObject[] } {
  if (!model)
    return {
      valid: false,
      model: null,
      errors: [
        {
          instancePath: "/",
          schemaPath: "/",
          keyword: "model",
          params: {},
          message: "Exactly one recognized OSCAL document model is required.",
        },
      ],
    };
  const validate = schemaValidator(model, root),
    valid = !!validate(document);
  return {
    valid,
    model,
    errors: valid ? [] : structuredClone(validate.errors ?? []),
  };
}
export function assertSchema(
  document: unknown,
  model: OscalModel | null = documentModel(document),
  root = findRepoRoot(),
) {
  const result = validateSchema(document, model, root);
  if (!result.valid)
    throw new AegisError(
      "OSCAL_SCHEMA",
      "OSCAL export failed pinned schema validation.",
      422,
      { errors: result.errors },
    );
  return document;
}
