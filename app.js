// app.js

const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");

const app = express();

const PORT = process.env.PORT || 3000;

const BASE_URL = "https://www.vesselfinder.com";
const PORT_URL = `${BASE_URL}/ports/TRIST001`;

const HEADERS = {
    "User-Agent": "Mozilla/5.0"
};

const PASSENGER_KEYWORDS = ["Passenger", "Cruise"];

// -----------------------------------------------------
// Helpers
// -----------------------------------------------------

function cleanText(value = "") {
    return value.replace(/\s+/g, " ").trim();
}

function absoluteUrl(href = "") {
    if (!href) return "";
    return new URL(href, BASE_URL).toString();
}

function isPassengerShip(type = "") {
    return PASSENGER_KEYWORDS.some(k =>
        type.toLowerCase().includes(k.toLowerCase())
    );
}

// -----------------------------------------------------
// Fetch HTML
// -----------------------------------------------------

async function fetchHtml(url) {
    const response = await axios.get(url, {
        headers: HEADERS
    });

    return cheerio.load(response.data);
}

// -----------------------------------------------------
// Parse KV Tables
// -----------------------------------------------------

function parseKeyValueTables($) {
    const data = {};

    $("table.tpt1, table.aparams, table.spt1, table.spt0fix, table.spt1fix")
        .each((_, table) => {

            $(table).find("tr").each((__, row) => {

                const cells = $(row).find("> td");

                if (cells.length !== 2) return;

                const key = cleanText($(cells[0]).text());
                const value = cleanText($(cells[1]).text());

                if (key && value) {
                    data[key] = value;
                }
            });
        });

    return data;
}

// -----------------------------------------------------
// Voyage Summary Parser
// -----------------------------------------------------

function parseVoyageText(summaryText = "") {

    const out = {};

    let m;

    m = summaryText.match(
        /The current position of .*? is\s+(.*?)\s+reported/i
    );

    if (m) {
        out.current_position = cleanText(m[1]);
    }

    m = summaryText.match(
        /en route to the port of\s+(.*?),\s*and expected to arrive/i
    );

    if (m) {
        out.destination = cleanText(m[1]);
    }

    m = summaryText.match(
        /expected to arrive there on\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{2}:\d{2})/i
    );

    if (m) {
        out.expected_arrival = cleanText(m[1]);
    }

    return out;
}

// -----------------------------------------------------
// Extract Ships From Port
// -----------------------------------------------------

async function extractPortShips() {

    const $ = await fetchHtml(PORT_URL);

    const section = $("#in-port");

    if (!section.length) {
        throw new Error("In Port section not found");
    }

    const ships = [];
    const seen = new Set();

    section.find("tbody tr").each((_, row) => {

        const titleEl = $(row).find(".named-title");
        const typeEl = $(row).find(".named-subtitle");
        const linkEl = $(row).find("a.named-item");

        if (!titleEl.length || !typeEl.length || !linkEl.length) {
            return;
        }

        const name = cleanText(titleEl.text());
        const type = cleanText(typeEl.text());

        if (!isPassengerShip(type)) {
            return;
        }

        const detailPath = linkEl.attr("href");
        const detailUrl = absoluteUrl(detailPath);

        const key = `${name}-${detailUrl}`;

        if (seen.has(key)) return;

        seen.add(key);

        ships.push({
            name,
            type,
            detail_url: detailUrl,
            vessel_id: detailUrl.split("/").pop()
        });
    });

    return ships;
}

// -----------------------------------------------------
// Parse Detail Page
// -----------------------------------------------------

async function parseDetailPage(detailUrl) {

    const $ = await fetchHtml(detailUrl);

    const result = {
        detail_url: detailUrl
    };

    // -------------------------------------------------
    // Basic
    // -------------------------------------------------

    const h1 = $("h1.title");
    const h2 = $("h2.vst");

    if (h1.length) {
        result.vessel_name = cleanText(h1.text());
    }

    if (h2.length) {
        result.subtitle = cleanText(h2.text());
    }

    // -------------------------------------------------
    // Photo
    // -------------------------------------------------

    const img = $("img.main-photo");

    if (img.length) {
        result.photo_url = absoluteUrl(img.attr("src"));
    }

    // -------------------------------------------------
    // Summary
    // -------------------------------------------------

    const summary = $("section.ship-section.text-section p.text2");

    if (summary.length) {

        const summaryText = cleanText(summary.text());

        result.summary_text = summaryText;

        Object.assign(
            result,
            parseVoyageText(summaryText)
        );
    }

    // -------------------------------------------------
    // Generic Tables
    // -------------------------------------------------

    const kv = parseKeyValueTables($);

    result.tables = kv;

    // -------------------------------------------------
    // Voyage Table
    // -------------------------------------------------

    const voyageTable = $("table.aparams").first();

    if (voyageTable.length) {

        const voyage = {};

        voyageTable.find("tr").each((_, row) => {

            const tds = $(row).find("> td");

            if (tds.length !== 2) return;

            const key = cleanText($(tds[0]).text());
            const value = cleanText($(tds[1]).text());

            if (key && value) {
                voyage[key] = value;
            }
        });

        result.voyage = {
            predicted_eta: voyage["Predicted ETA"] || "",
            distance_time: voyage["Distance / Time"] || "",
            course_speed: voyage["Course / Speed"] || "",
            current_draught: voyage["Current draught"] || "",
            navigation_status: voyage["Navigation Status"] || "",
            position_received: voyage["Position received"] || "",
            imo_mmsi: voyage["IMO / MMSI"] || "",
            callsign: voyage["Callsign"] || "",
            ais_type: voyage["AIS Type"] || "",
            ais_flag: voyage["AIS Flag"] || "",
            length_beam: voyage["Length / Beam"] || ""
        };

        // Last Port

        const lastPortBox = voyageTable.nextAll("div.vi__stp").first();

        if (lastPortBox.length) {

            result.voyage.last_port =
                cleanText(lastPortBox.find("a._npNa").text());

            result.voyage.last_port_time =
                cleanText(lastPortBox.find("div._value").text());
        }
    }

    // -------------------------------------------------
    // Vessel Particulars
    // -------------------------------------------------

    result.particulars = {};

    $("h2.bar").each((_, el) => {

        const text = cleanText($(el).text());

        if (text !== "Vessel Particulars") return;

        const section = $(el).closest("section");

        section.find("table.tpt1 tr").each((__, row) => {

            const tds = $(row).find("> td");

            if (tds.length !== 2) return;

            const key = cleanText($(tds[0]).text());
            const value = cleanText($(tds[1]).text());

            if (key && value) {
                result.particulars[key] = value;
            }
        });
    });

    return result;
}

// -----------------------------------------------------
// ROUTES
// -----------------------------------------------------

// Health Check
app.get("/", (_, res) => {
    res.json({
        success: true,
        service: "Galataport Vessel API"
    });
});

// -----------------------------------------------------
// GET /docked
// Current docked cruise/passenger ships
// -----------------------------------------------------

app.get("/docked", async (_, res) => {

    try {

        const ships = await extractPortShips();

        res.json({
            success: true,
            count: ships.length,
            port: "Galataport Istanbul",
            ships
        });

    } catch (err) {

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// -----------------------------------------------------
// GET /ship/:id
// Example:
// /ship/9189421
// -----------------------------------------------------

app.get("/ship/:id", async (req, res) => {

    try {

        const id = req.params.id;

        const detailUrl =
            `${BASE_URL}/vessels/details/${id}`;

        const data = await parseDetailPage(detailUrl);

        res.json({
            success: true,
            vessel_id: id,
            data
        });

    } catch (err) {

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// -----------------------------------------------------
// GET /docked/details
// All docked ships with full details
// -----------------------------------------------------

app.get("/docked/details", async (_, res) => {

    try {

        const ships = await extractPortShips();

        const detailed = [];

        for (const ship of ships) {

            try {

                const detail =
                    await parseDetailPage(ship.detail_url);

                detailed.push(detail);

            } catch (err) {

                detailed.push({
                    name: ship.name,
                    error: err.message
                });
            }
        }

        res.json({
            success: true,
            count: detailed.length,
            ships: detailed
        });

    } catch (err) {

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// -----------------------------------------------------

app.listen(PORT, () => {
    console.log(
        `Server running on http://localhost:${PORT}`
    );
});
