require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Constants ───────────────────────────────────────────────────────────────
const CAPTCHA_POLL_INTERVAL_MS = 5000;
const CAPTCHA_MAX_POLLS = 20;
const CAPTCHA_INITIAL_WAIT_MS = 5000;
const TM_SEARCH_URL = "https://tmrsearch.ipindia.gov.in/tmrpublicsearch/";

// ─── Search Type Maps ────────────────────────────────────────────────────────
const SEARCH_TYPE_MAP = {
    wordmark: "Wordmark",     // default
    vienna: "Vienna Code",
    phonetic: "Phonetic",
};

// matchType only applies when searchType === "wordmark"
const MATCH_TYPE_MAP = {
    startwith: "Start With",   // default
    contains: "Contains",
    matchwith: "Match With",
};

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(tag, msg) {
    console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

// ─── Custom Error Classes ─────────────────────────────────────────────────────
class CaptchaError extends Error {
    constructor(message, code = "CAPTCHA_ERROR") {
        super(message); this.name = "CaptchaError"; this.code = code;
    }
}
class ScrapingError extends Error {
    constructor(message, code = "SCRAPING_ERROR") {
        super(message); this.name = "ScrapingError"; this.code = code;
    }
}
class ValidationError extends Error {
    constructor(message) {
        super(message); this.name = "ValidationError"; this.code = "VALIDATION_ERROR";
    }
}
class AuthError extends Error {
    constructor(message) {
        super(message); this.name = "AuthError"; this.code = "UNAUTHORIZED";
    }
}

// ─── API Key Auth Middleware ──────────────────────────────────────────────────
function authenticate(req, res, next) {
    const envKey = process.env.API_KEY;
    if (!envKey) {
        return errorResponse(res, 500, { code: "AUTH_CONFIG_ERROR", message: "API key is not configured on the server." });
    }

    // Accept key from header OR query param
    const provided = req.headers["x-api-key"] || req.query.apiKey || req.body?.apiKey;
    if (!provided) {
        return errorResponse(res, 401, new AuthError("API key is missing"));
    }
    if (provided !== envKey) {
        return errorResponse(res, 401, new AuthError("Invalid API key."));
    }
    next();
}

// ─── Input Validator ─────────────────────────────────────────────────────────
function validateSearchParams({ keyword, tmClass, searchType, matchType }) {
    if (!keyword || typeof keyword !== "string" || keyword.trim().length === 0)
        throw new ValidationError("'keyword' is required and must be a non-empty string.");
    if (keyword.trim().length > 100)
        throw new ValidationError("'keyword' must be 100 characters or fewer.");

    if (tmClass !== undefined) {
        const classNum = parseInt(tmClass, 10);
        if (isNaN(classNum) || classNum < 1 || classNum > 45)
            throw new ValidationError("'tmClass' must be a number between 1 and 45.");
    }

    if (searchType !== undefined && !SEARCH_TYPE_MAP[searchType.toLowerCase()]) {
        throw new ValidationError(
            `'searchType' must be one of: ${Object.keys(SEARCH_TYPE_MAP).join(", ")}.`
        );
    }

    if (matchType !== undefined && !MATCH_TYPE_MAP[matchType.toLowerCase()]) {
        throw new ValidationError(
            `'matchType' must be one of: ${Object.keys(MATCH_TYPE_MAP).join(", ")}.`
        );
    }

    // matchType only makes sense for wordmark search
    const resolvedSearchType = (searchType || "wordmark").toLowerCase();
    if (matchType && resolvedSearchType !== "wordmark") {
        throw new ValidationError("'matchType' can only be used when 'searchType' is 'wordmark'.");
    }
}

// ─── Captcha Solver ──────────────────────────────────────────────────────────
async function solveCaptchaWithAZ(imageBase64) {
    const apiKey = process.env.AZCAPTCHA_KEY;
    if (!apiKey)
        throw new CaptchaError("AZCAPTCHA_KEY is not set in environment.", "CAPTCHA_CONFIG_ERROR");

    let sendRes;
    try {
        sendRes = await axios.post(
            "http://azcaptcha.com/in.php",
            new URLSearchParams({ key: apiKey, method: "base64", body: imageBase64, json: 1 }),
            { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
        );
    } catch (err) {
        throw new CaptchaError(`Failed to submit captcha: ${err.message}`, "CAPTCHA_SUBMIT_ERROR");
    }

    if (sendRes.data.status !== 1)
        throw new CaptchaError(`AZCaptcha rejected submission: ${sendRes.data.request}`, "CAPTCHA_SUBMIT_REJECTED");

    const captchaId = sendRes.data.request;
    await delay(CAPTCHA_INITIAL_WAIT_MS);

    for (let attempt = 1; attempt <= CAPTCHA_MAX_POLLS; attempt++) {
        let resultRes;
        try {
            resultRes = await axios.get("http://azcaptcha.com/res.php", {
                params: { key: apiKey, action: "get", id: captchaId, json: 1 },
                timeout: 10000
            });
        } catch (err) {
            throw new CaptchaError(`Failed to poll captcha: ${err.message}`, "CAPTCHA_POLL_ERROR");
        }

        if (resultRes.data.status === 1) {
            return resultRes.data.request;
        }
        if (resultRes.data.request !== "CAPCHA_NOT_READY")
            throw new CaptchaError(`AZCaptcha error: ${resultRes.data.request}`, "CAPTCHA_SOLVE_ERROR");

        await delay(CAPTCHA_POLL_INTERVAL_MS);
    }

    throw new CaptchaError("Captcha solving timed out.", "CAPTCHA_TIMEOUT");
}

// ─── Page Scraper ────────────────────────────────────────────────────────────
async function scrapeTrademarks({ keyword, tmClass, searchType, matchType }) {
    // Resolve to site label values
    const resolvedSearchType = SEARCH_TYPE_MAP[(searchType || "wordmark").toLowerCase()];
    const resolvedMatchType = MATCH_TYPE_MAP[(matchType || "startwith").toLowerCase()];

    const browser = await chromium.launch({ headless: true }).catch((err) => {
        throw new ScrapingError(`Failed to launch browser: ${err.message}`, "BROWSER_LAUNCH_ERROR");
    });

    const page = await browser.newPage();
    page.on("pageerror", (err) => log("PAGE_ERROR", err.message));

    try {
        // ── Navigate ──────────────────────────────────────────────────────────
        await page.goto(TM_SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((err) => {
            throw new ScrapingError(`Navigation failed: ${err.message}`, "NAVIGATION_ERROR");
        });

        // ── Select Search Type dropdown ───────────────────────────────────────
        const searchTypeDropdown = await page.$("#ContentPlaceHolder1_DDLSearchType").catch(() => null);
        if (searchTypeDropdown) {
            await page.selectOption("#ContentPlaceHolder1_DDLSearchType", { label: resolvedSearchType });
            await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() =>
                log("SCRAPER", "networkidle timeout after searchType change — continuing")
            );
            await page.waitForTimeout(1000);
        } else {
            log("SCRAPER", "WARNING: Search type dropdown (#ContentPlaceHolder1_DDLSearchType) not found — skipping");
        }

        // ── Select Match Type dropdown (Wordmark only) ────────────────────────
        if ((searchType || "wordmark").toLowerCase() === "wordmark") {
            const matchTypeDropdown = await page.$("#ContentPlaceHolder1_DDLFilter").catch(() => null);
            if (matchTypeDropdown) {
                await page.selectOption("#ContentPlaceHolder1_DDLFilter", { label: resolvedMatchType });
            } else {
                log("SCRAPER", "WARNING: Match type dropdown (#ContentPlaceHolder1_DDLFilter) not found — skipping");
            }
        }

        // ── Fill keyword (selector depends on searchType) ─────────────────────
        const KEYWORD_INPUT_MAP = {
            wordmark: "#ContentPlaceHolder1_TBWordmark",
            vienna: "#ContentPlaceHolder1_TBViennaCode",
            phonetic: "#ContentPlaceHolder1_TBPhonetic",
        };
        const keywordSelector = KEYWORD_INPUT_MAP[(searchType || "wordmark").toLowerCase()];
        const keywordField = await page.$(keywordSelector).catch(() => null);
        if (!keywordField)
            throw new ScrapingError(
                `Keyword input field not found for searchType="${searchType}" (selector: ${keywordSelector}).`,
                "FORM_FILL_ERROR"
            );
        await page.fill(keywordSelector, keyword.trim());

        // ── Fill class (optional) ─────────────────────────────────────────────
        if (tmClass) {
            const classField = await page.$("#ContentPlaceHolder1_TBClass").catch(() => null);
            if (classField) await page.fill("#ContentPlaceHolder1_TBClass", String(tmClass));
        }

        // ── Capture & solve captcha ───────────────────────────────────────────
        await page.waitForSelector("#ContentPlaceHolder1_ImageCaptcha", { timeout: 15000 }).catch(() => {
            throw new ScrapingError("Captcha image not found on page.", "CAPTCHA_NOT_FOUND");
        });
        const captchaElement = await page.$("#ContentPlaceHolder1_ImageCaptcha");
        const captchaBase64 = (await captchaElement.screenshot()).toString("base64");

        const solvedCaptcha = await solveCaptchaWithAZ(captchaBase64);

        // ── Fill captcha answer ───────────────────────────────────────────────
        const captchaInput = await page.$("#ContentPlaceHolder1_captcha1");
        if (!captchaInput)
            throw new ScrapingError("Captcha answer input field not found.", "CAPTCHA_FILL_ERROR");
        await page.fill("#ContentPlaceHolder1_captcha1", solvedCaptcha);

        const searchBtn = await page.$("#ContentPlaceHolder1_BtnSearch");
        if (!searchBtn)
            throw new ScrapingError("Search button not found on page.", "SUBMIT_ERROR");

        const RESULT_SELECTORS = [
            "#ContentPlaceHolder1_MGVSearchResult",  
            "#ContentPlaceHolder1_LblError",         
            "#ContentPlaceHolder1_LblNoRecFound",    
        ].join(", ");

        await page.click("#ContentPlaceHolder1_BtnSearch");

        await page.waitForSelector(RESULT_SELECTORS, { timeout: 100000 }).catch(() => {
            log("SCRAPER", "WARNING: Timed out waiting for any result/error selector — will attempt extraction anyway");
        });

        await page.waitForTimeout(500);

        // ── Check for on-page error ───────────────────────────────────────────
        const errorEl = await page.$("#ContentPlaceHolder1_LblError").catch(() => null);
        if (errorEl) {
            const errorText = await errorEl.innerText().catch(() => "");
            if (errorText.trim())
                throw new ScrapingError(`Site returned error: ${errorText.trim()}`, "CAPTCHA_REJECTED");
        }

        // ── Check for explicit no-results label ───────────────────────────────
        const noRecordEl = await page.$("#ContentPlaceHolder1_LblNoRecFound").catch(() => null);
        if (noRecordEl) {
            const noRecText = await noRecordEl.innerText().catch(() => "");
            if (noRecText.trim()) {
                return { results: [], message: "No results found." };
            }
        }

        // ── Wait for results table ────────────────────────────────────────────
        const tableEl = await page.$("#ContentPlaceHolder1_MGVSearchResult").catch(() => null);

        if (!tableEl) {
            return { results: [], message: "No results found." };
        }

        const rowCount = await page.$$eval("#ContentPlaceHolder1_MGVSearchResult tr", (r) => r.length).catch(() => 0);

        if (rowCount < 2)
            return { results: [], message: "Table found but contains no data rows." };

        // ── Extract table data ────────────────────────────────────────────────
        const tableData = await page.$$eval(
            "#ContentPlaceHolder1_MGVSearchResult tr",
            (rows) => {
                const headers = Array.from(rows[0].querySelectorAll("th")).map((th) => th.innerText.trim());
                return Array.from(rows).slice(1).map((row) => {
                    const cells = Array.from(row.querySelectorAll("td"));
                    let obj = {};
                    cells.forEach((cell, i) => { obj[headers[i] || `col_${i}`] = cell.innerText.trim(); });
                    return obj;
                });
            }
        ).catch((err) => {
            throw new ScrapingError(`Failed to extract table data: ${err.message}`, "EXTRACTION_ERROR");
        });

        // ── Normalize rows ────────────────────────────────────────────────────
        const cleanedData = tableData
            .filter((row) => row && Object.keys(row).length > 0)
            .map((row) => {
                const docKey = Object.keys(row).find((k) => /document/i.test(k)) || Object.keys(row)[1];
                const lines = (row[docKey] || "")
                    .split("\n")
                    .map((l) => l.trim())
                    .filter((l) => l && l !== "Show Details");

                let structured = { sl_no: row["Sl. No."] || row[Object.keys(row)[0]] || null };
                lines.forEach((line) => {
                    const ci = line.indexOf(":");
                    if (ci === -1) return;
                    const key = line.slice(0, ci).trim().toLowerCase();
                    const value = line.slice(ci + 1).trim();
                    if (!value) return;
                    switch (key) {
                        case "wordmark": structured.wordmark = value; break;
                        case "proprietor": structured.proprietor = value; break;
                        case "application number": structured.application_number = value; break;
                        case "class / classes": structured.class = value; break;
                        case "status": structured.status = value; break;
                        default: structured[key.replace(/\s+/g, "_")] = value;
                    }
                });
                return structured;
            });

        return { results: cleanedData, total: cleanedData.length };

    } finally {
        await page.close().catch(() => { });
        await browser.close().catch(() => { });
    }
}

// ─── Utility ─────────────────────────────────────────────────────────────────
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function errorResponse(res, statusCode, error) {
    return res.status(statusCode).json({
        success: false,
        error: { code: error.code || "INTERNAL_ERROR", message: error.message || "An unexpected error occurred." }
    });
}

// ─── Shared Request Handler ───────────────────────────────────────────────────
async function handleSearch(req, res, params) {
    const {
        keyword,
        tmClass,
        searchType = "wordmark",
        matchType,              
    } = params;
 
    try { validateSearchParams({ keyword, tmClass, searchType, matchType }); }
    catch (err) { return errorResponse(res, 400, err); }
 
    const resolvedMatchType = searchType.toLowerCase() === "wordmark"
        ? (matchType || "startwith")
        : null;
 
    log("REQUEST", `keyword="${keyword}" tmClass=${tmClass || "any"} searchType=${searchType} matchType=${resolvedMatchType}`);
 
    try {
        const data = await scrapeTrademarks({ keyword, tmClass, searchType, matchType: resolvedMatchType });
        return res.json({
            success: true,
            keyword,
            tmClass:    tmClass    || null,
            searchType: searchType || "wordmark",
            matchType:  resolvedMatchType,
            ...data,
        });
    } catch (err) {
        log("ERROR", `${err.name} [${err.code}]: ${err.message}`);
        if (err instanceof ValidationError) return errorResponse(res, 400, err);
        if (err instanceof CaptchaError)    return errorResponse(res, 502, err);
        if (err instanceof ScrapingError)   return errorResponse(res, 502, err);
        return errorResponse(res, 500, { code: "INTERNAL_ERROR", message: "An unexpected server error occurred." });
    }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
    res.json({ success: true, status: "ok", timestamp: new Date().toISOString() })
);

// Protected trademark search routes
app.post("/api/trademark/search", authenticate, (req, res) => handleSearch(req, res, req.body));
app.get("/api/trademark/search", authenticate, (req, res) => handleSearch(req, res, req.query));

app.use((req, res) =>
    res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.path} not found.` } })
);
app.use((err, req, res, _next) => {
    return errorResponse(res, 500, { code: "INTERNAL_ERROR", message: "An unexpected error occurred." });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    log("SERVER", `✅ Running on http://localhost:${PORT}`);
});
