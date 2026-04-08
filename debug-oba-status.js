#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
let UndiciAgent = null;
try {
  ({ Agent: UndiciAgent } = require("undici"));
} catch {
  UndiciAgent = null;
}

const DEFAULT_GRAPH_VERSION = "v22.0";
let loadedEnvFilePath = null;
let graphFetchDispatcher = null;
let graphInsecureTlsMode = false;
let graphTlsModeLabel = "default";

const TLS_CERT_ERROR_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
]);

class GraphApiError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "GraphApiError";
    this.details = details;
  }
}

function findNearestEnvFile(startDir) {
  let currentDir = startDir;
  while (true) {
    const candidate = path.join(currentDir, ".env");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }
  return null;
}

function parseDotEnvLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const eqIndex = trimmed.indexOf("=");
  if (eqIndex <= 0) return null;

  const key = trimmed.slice(0, eqIndex).trim();
  if (!key) return null;

  let value = trimmed.slice(eqIndex + 1).trim();
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  value = value.replace(/\\n/g, "\n");
  return { key, value };
}

function loadEnvFileIfPresent() {
  const explicitEnvPath = (process.env.DOTENV_PATH || "").trim();
  const resolvedPath = explicitEnvPath
    ? path.resolve(process.cwd(), explicitEnvPath)
    : findNearestEnvFile(process.cwd());

  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return null;
  }

  const content = fs.readFileSync(resolvedPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseDotEnvLine(line);
    if (!parsed) continue;
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
    }
  }

  loadedEnvFilePath = resolvedPath;
  return resolvedPath;
}

function parseBooleanEnv(value, fallback = false) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function isTlsCertError(error) {
  const code = String(error?.cause?.code || error?.code || "")
    .trim()
    .toUpperCase();
  return TLS_CERT_ERROR_CODES.has(code);
}

function buildFetchOptions(config) {
  const options = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.graphToken}`,
      "Content-Type": "application/json",
    },
  };

  if (graphFetchDispatcher) {
    options.dispatcher = graphFetchDispatcher;
  }

  return options;
}

function configureGraphTlsFromEnv() {
  const certPathRaw = (process.env.GRAPH_CA_CERT_PATH || process.env.CA_CERT_PATH || "").trim();
  if (!certPathRaw || !UndiciAgent) return;

  const certPath = path.resolve(process.cwd(), certPathRaw);
  if (!fs.existsSync(certPath)) {
    console.warn(`[tls] GRAPH_CA_CERT_PATH no existe: ${certPath}`);
    return;
  }

  const certPem = fs.readFileSync(certPath, "utf8");
  graphFetchDispatcher = new UndiciAgent({
    connect: {
      rejectUnauthorized: true,
      ca: certPem,
    },
  });
  graphTlsModeLabel = `custom-ca:${certPath}`;
}

function tryEnableInsecureTlsRetry(error) {
  if (graphInsecureTlsMode) return false;
  if (!isTlsCertError(error)) return false;

  const disableRetry = parseBooleanEnv(process.env.GRAPH_DISABLE_INSECURE_RETRY, false);
  const allowRetry = parseBooleanEnv(process.env.GRAPH_ALLOW_INSECURE_RETRY, !disableRetry);
  if (!allowRetry) return false;

  if (UndiciAgent) {
    graphFetchDispatcher = new UndiciAgent({
      connect: {
        rejectUnauthorized: false,
      },
    });
  } else {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  graphInsecureTlsMode = true;
  graphTlsModeLabel = "insecure-retry";

  console.warn("");
  console.warn("[tls] WARNING: activando retry inseguro TLS para Graph API (solo debug).");
  console.warn("[tls] Usa GRAPH_CA_CERT_PATH=<ruta_certificado.pem> para solucion segura.");
  console.warn("");
  return true;
}

function getConfig() {
  const config = {
    graphToken: (process.env.GRAPH_API_TOKEN || "").trim(),
    graphVersion: (process.env.WHATSAPP_API_VERSION || DEFAULT_GRAPH_VERSION).trim() || DEFAULT_GRAPH_VERSION,
    phoneNumberId: (process.env.PHONE_NUMBER_ID || "").trim(),
    wabaId: (process.env.WABA_ID || "").trim(),
  };

  const missing = [];
  if (!config.graphToken) missing.push("GRAPH_API_TOKEN");
  if (!config.phoneNumberId) missing.push("PHONE_NUMBER_ID");
  if (!config.wabaId) missing.push("WABA_ID");

  if (missing.length > 0) {
    const envHint = loadedEnvFilePath
      ? `Se cargo .env desde: ${loadedEnvFilePath}`
      : "No se encontro archivo .env en este directorio o directorios padre.";
    throw new Error(`Faltan variables de entorno requeridas: ${missing.join(", ")}. ${envHint}`);
  }

  return config;
}

function graphBaseUrl(graphVersion) {
  return `https://graph.facebook.com/${graphVersion}`;
}

function stringifyBody(body) {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

function normalizeUpper(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

async function graphGet(config, objectId, fields = []) {
  const url = new URL(`${graphBaseUrl(config.graphVersion)}/${objectId}`);
  if (fields.length > 0) {
    url.searchParams.set("fields", fields.join(","));
  }

  let response;
  try {
    response = await fetch(url, buildFetchOptions(config));
  } catch (error) {
    if (!tryEnableInsecureTlsRetry(error)) {
      throw error;
    }
    response = await fetch(url, buildFetchOptions(config));
  }

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const graphError = payload && typeof payload === "object" ? payload.error : null;
    throw new GraphApiError(
      `Graph API error ${response.status}${graphError?.message ? `: ${graphError.message}` : ""}`,
      {
        status: response.status,
        statusText: response.statusText,
        url: url.toString(),
        requestId: response.headers.get("x-fb-trace-id") || response.headers.get("x-fb-request-id") || null,
        payload,
      },
    );
  }

  return payload;
}

function isInvalidFieldError(error) {
  if (!(error instanceof GraphApiError)) return false;
  const code = Number(error.details?.payload?.error?.code);
  const message = String(error.details?.payload?.error?.message || "").toLowerCase();
  return code === 100 || message.includes("unknown field") || message.includes("cannot be queried");
}

async function graphGetOptionalField(config, objectId, field) {
  try {
    const payload = await graphGet(config, objectId, [field]);
    return { supported: true, value: payload?.[field] ?? null };
  } catch (error) {
    if (isInvalidFieldError(error)) {
      return { supported: false, value: null };
    }
    throw error;
  }
}

async function getPhoneOBAStatus(config) {
  const coreFields = [
    "id",
    "display_phone_number",
    "verified_name",
    "quality_rating",
    "code_verification_status",
    "name_status",
  ];

  const core = await graphGet(config, config.phoneNumberId, coreFields);

  const optionalFieldChecks = await Promise.all([
    graphGetOptionalField(config, config.phoneNumberId, "is_official_business_account"),
    graphGetOptionalField(config, config.phoneNumberId, "official_business_account"),
    graphGetOptionalField(config, config.phoneNumberId, "official_business_account_status"),
  ]);

  const [isObaFlag, obaObject, obaStatus] = optionalFieldChecks;

  return {
    core,
    optional: {
      is_official_business_account: isObaFlag,
      official_business_account: obaObject,
      official_business_account_status: obaStatus,
    },
  };
}

async function getWabaReviewStatus(config) {
  const fields = [
    "id",
    "name",
    "account_review_status",
    "business_verification_status",
    "message_template_namespace",
  ];

  return graphGet(config, config.wabaId, fields);
}

function evaluatePhoneOba(phoneData) {
  const rawFlag = phoneData.optional.is_official_business_account;
  const rawObaObj = phoneData.optional.official_business_account;
  const rawObaStatus = phoneData.optional.official_business_account_status;
  const nameStatus = normalizeUpper(phoneData.core?.name_status);
  const obaObjectStatus = normalizeUpper(
    rawObaObj?.value?.oba_status || rawObaObj?.value?.status || rawObaObj?.value?.review_status,
  );

  if (rawFlag.supported && rawFlag.value === true) {
    return {
      approved: true,
      source: "is_official_business_account",
      reason: "El numero reporta bandera oficial = true.",
    };
  }

  if (rawObaStatus.supported && normalizeUpper(rawObaStatus.value) === "APPROVED") {
    return {
      approved: true,
      source: "official_business_account_status",
      reason: "El numero reporta official_business_account_status = APPROVED.",
    };
  }

  if (rawObaObj.supported && rawObaObj.value && obaObjectStatus === "APPROVED") {
    return {
      approved: true,
      source: "official_business_account",
      reason: "El numero reporta official_business_account.oba_status = APPROVED.",
    };
  }

  if (rawObaObj.supported && rawObaObj.value && obaObjectStatus) {
    return {
      approved: false,
      source: "official_business_account",
      reason: `official_business_account.oba_status = ${obaObjectStatus} (no aprobado).`,
    };
  }

  if (nameStatus === "APPROVED") {
    return {
      approved: false,
      source: "name_status",
      reason:
        "name_status = APPROVED (nombre aprobado), pero no se obtuvo campo explicito de OBA. Tratalo como NO confirmado para Groups API.",
    };
  }

  return {
    approved: false,
    source: "fallback",
    reason: `No hay evidencia explicita de OBA aprobado. name_status=${phoneData.core?.name_status || "N/A"}.`,
  };
}

function evaluateWaba(wabaData) {
  const reviewStatus = normalizeUpper(wabaData?.account_review_status);
  const approved = reviewStatus === "APPROVED";
  return {
    approved,
    status: wabaData?.account_review_status || "N/A",
    reason: approved
      ? "WABA aprobado para revision de cuenta."
      : `WABA NO aprobado. account_review_status=${wabaData?.account_review_status || "N/A"}.`,
  };
}

function evaluateGroupsEligibility(phoneEval, wabaEval) {
  const blockers = [];
  if (!phoneEval.approved) blockers.push("Numero sin OBA aprobado (o no confirmado)");
  if (!wabaEval.approved) blockers.push("WABA sin account_review_status = APPROVED");

  const eligible = blockers.length === 0;
  return {
    eligible,
    blockers,
    message: eligible
      ? "El negocio ya califica para Groups API (por chequeos de OBA + account_review_status)."
      : `El negocio TODAVIA NO califica para Groups API: ${blockers.join("; ")}.`,
  };
}

function printHeader(config) {
  console.log("\n=== WhatsApp Cloud API | OBA + WABA Debug ===");
  console.log(`GRAPH version: ${config.graphVersion}`);
  console.log(`TLS mode inicial: ${graphTlsModeLabel}`);
  console.log(`PHONE_NUMBER_ID: ${config.phoneNumberId}`);
  console.log(`WABA_ID: ${config.wabaId}`);
  if (loadedEnvFilePath) {
    console.log(`.env cargado desde: ${loadedEnvFilePath}`);
  }
}

function printPhoneResult(phoneData, phoneEval) {
  console.log("\n[1/3] Estado OBA del numero");
  console.log(`display_phone_number: ${phoneData.core?.display_phone_number || "N/A"}`);
  console.log(`verified_name: ${phoneData.core?.verified_name || "N/A"}`);
  console.log(`quality_rating: ${phoneData.core?.quality_rating || "N/A"}`);
  console.log(`name_status: ${phoneData.core?.name_status || "N/A"}`);
  console.log(`code_verification_status: ${phoneData.core?.code_verification_status || "N/A"}`);

  console.log("\nCampos OBA opcionales:");
  console.log(
    `- is_official_business_account: ${
      phoneData.optional.is_official_business_account.supported
        ? String(phoneData.optional.is_official_business_account.value)
        : "no soportado por esta version/objeto"
    }`,
  );
  console.log(
    `- official_business_account: ${
      phoneData.optional.official_business_account.supported
        ? stringifyBody(phoneData.optional.official_business_account.value) || "null"
        : "no soportado por esta version/objeto"
    }`,
  );
  console.log(
    `- official_business_account_status: ${
      phoneData.optional.official_business_account_status.supported
        ? String(phoneData.optional.official_business_account_status.value)
        : "no soportado por esta version/objeto"
    }`,
  );

  console.log(`\nOBA aprobado (numero): ${phoneEval.approved ? "SI" : "NO"}`);
  console.log(`Detalle: ${phoneEval.reason}`);
}

function printWabaResult(wabaData, wabaEval) {
  console.log("\n[2/3] Estado de revision del WABA");
  console.log(`name: ${wabaData?.name || "N/A"}`);
  console.log(`account_review_status: ${wabaData?.account_review_status || "N/A"}`);
  console.log(`business_verification_status: ${wabaData?.business_verification_status || "N/A"}`);
  console.log(`message_template_namespace: ${wabaData?.message_template_namespace || "N/A"}`);
  console.log(`\nWABA aprobado: ${wabaEval.approved ? "SI" : "NO"}`);
  console.log(`Detalle: ${wabaEval.reason}`);
}

function printEligibility(groupsEval) {
  console.log("\n[3/3] Elegibilidad Groups API");
  console.log(`Califica para Groups API: ${groupsEval.eligible ? "SI" : "NO"}`);
  console.log(groupsEval.message);
  console.log(`TLS mode final: ${graphTlsModeLabel}`);
}

function printDetailedError(error) {
  console.error("\n=== ERROR COMPLETO ===");
  if (error instanceof GraphApiError) {
    console.error(`Mensaje: ${error.message}`);
    console.error(`HTTP: ${error.details?.status || "N/A"} ${error.details?.statusText || ""}`);
    console.error(`URL: ${error.details?.url || "N/A"}`);
    console.error(`Request ID: ${error.details?.requestId || "N/A"}`);
    console.error("Payload:");
    console.error(stringifyBody(error.details?.payload));
    return;
  }

  if (error instanceof Error) {
    console.error(`Mensaje: ${error.message}`);
    if (error.cause) {
      console.error("Cause:");
      console.error(stringifyBody(error.cause));
    }
    console.error(error.stack || "(sin stack)");
    return;
  }

  console.error(stringifyBody(error));
}

async function main() {
  loadEnvFileIfPresent();
  configureGraphTlsFromEnv();
  const config = getConfig();
  printHeader(config);

  const phoneData = await getPhoneOBAStatus(config);
  const wabaData = await getWabaReviewStatus(config);

  const phoneEval = evaluatePhoneOba(phoneData);
  const wabaEval = evaluateWaba(wabaData);
  const groupsEval = evaluateGroupsEligibility(phoneEval, wabaEval);

  printPhoneResult(phoneData, phoneEval);
  printWabaResult(wabaData, wabaEval);
  printEligibility(groupsEval);

  console.log("\nDebug finalizado.\n");
}

main().catch((error) => {
  printDetailedError(error);
  process.exitCode = 1;
});
