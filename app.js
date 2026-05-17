const express = require("express");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const app = express();

const BASE_URL = "https://www.vesselfinder.com";
const PORT_URL = `${BASE_URL}/ports/TRIST001`;
const API_BASE = `${BASE_URL}/api/pub`;

const HEADERS = {
  "User-Agent": "Mozilla/5.0",
  "Accept": "*/*",
  "Referer": "https://www.vesselfinder.com/",
  "Origin": "https://www.vesselfinder.com/",
  "Connection": "keep-alive",
};

const PASSENGER_KEYWORDS = ["Passenger", "Cruise"];
const SCALE = 600000;

const GALATAPORT_BBOX = {
  lat_min: 41.018,
  lon_min: 28.975,
  lat_max: 41.045,
  lon_max: 29.01,
};

const START_DMS = `41°01'40.88"N 28°59'18.25"E`;
const MIDDLE_DMS = `41°01'31.03"N 28°58'57.03"E`;
const END_DMS = `41°01'24.85"N 28°58'47.72"E`;

function cleanText(value) {
  if (!value) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function absoluteUrl(href) {
  if (!href) return "";
  return new URL(href, BASE_URL).toString();
}

function extractMmsi(value) {
  if (!value) return null;
  const matches = String(value).match(/\b(\d{9})\b/g);
  return matches ? Number(matches[matches.length - 1]) : null;
}

function dmsToDecimal(dms) {
  const parts = dms.trim().split(/\s+/);
  if (parts.length !== 2) throw new Error(`Invalid DMS string: ${dms}`);

  function one(v) {
    const m = v.match(/^\s*(\d+)[°\s]+(\d+)[\'\s]+(\d+(?:\.\d+)?)["\s]*([NSEW])\s*$/);
    if (!m) throw new Error(`Invalid DMS token: ${v}`);
    const [, deg, minute, sec, hemi] = m;
    let dec = Number(deg) + Number(minute) / 60 + Number(sec) / 3600;
    if (hemi === "S" || hemi === "W") dec = -dec;
    return dec;
  }

  return [one(parts[0]), one(parts[1])];
}

function loadVenues(jsonPath = "galataport_venues.json") {
  const raw = fs.readFileSync(jsonPath, "utf8");
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : data.venues || [];
}

function intervalOverlap(a0, a1, b0, b1) {
  const left = Math.max(Math.min(a0, a1), Math.min(b0, b1));
  const right = Math.min(Math.max(a0, a1), Math.max(b0, b1));
  return Math.max(0, right - left);
}

function isFoodVenue(v) {
  const blob = [
    v.id,
    v.title_tr,
    v.title_en,
    v.category,
    v.location_ref,
    v.text,
  ]
    .map((x) => String(x || "").toLowerCase())
    .join(" ");

  const foodKeywords = new Set([
    "food", "beverage", "restaurant", "cafe", "coffee", "bar", "bistro",
    "diner", "lounge", "bakery", "patisserie", "pastry", "dessert",
    "ice cream", "gelato", "kitchen", "brasserie", "eatery", "grill",
    "fast food", "pizza", "burger", "sandwich", "tea", "juice", "pub",
    "wine", "breakfast", "brunch", "sushi", "pasta", "chocolate",
  ]);

  for (const k of foodKeywords) {
    if (blob.includes(k)) return true;
  }
  return false;
}

function isViewRelevantVenue(v) {
  const category = String(v.category || "").toLowerCase();
  const titleTr = String(v.title_tr || "").toLowerCase();
  const titleEn = String(v.title_en || "").toLowerCase();
  const text = [
    titleTr,
    titleEn,
    category,
    String(v.location_ref || "").toLowerCase(),
    String(v.text || "").toLowerCase(),
  ].join(" ");

  const excludedCategories = ["service", "wc", "office", "carpark", "port"];
  if (excludedCategories.some((cat) => category.includes(cat))) return false;

  const excludedKeywords = [
    "lobby", "kiosk", "parking", "valet", "wc", "restroom", "toilet",
    "square", "pier", "block", "fountain", "mosque", "park",
    "passenger hall", "payment", "ticket", "stair", "stairs",
  ];
  if (excludedKeywords.some((k) => text.includes(k))) return false;

  if (isFoodVenue(v)) return true;
  if (category.includes("shop")) return true;

  return false;
}

function parseFloatSafe(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

class GalataPortAxis {
  constructor(points) {
    if (!points || points.length < 2) throw new Error("Need at least 2 route points.");
    this.points = points;
    this.lat0 = points[0].lat;
    this.lon0 = points[0].lon;
    this.R = 6371000;

    this.routeXY = points.map((p) => this.llToXY(p.lat, p.lon));
    this.cum = [0];
    for (let i = 0; i < this.routeXY.length - 1; i++) {
      const [x1, y1] = this.routeXY[i];
      const [x2, y2] = this.routeXY[i + 1];
      this.cum.push(this.cum[this.cum.length - 1] + Math.hypot(x2 - x1, y2 - y1));
    }
  }

  llToXY(lat, lon) {
    const latRad0 = (this.lat0 * Math.PI) / 180;
    const x = this.R * ((lon - this.lon0) * Math.PI / 180) * Math.cos(latRad0);
    const y = this.R * ((lat - this.lat0) * Math.PI / 180);
    return [x, y];
  }

  xyToLL(x, y) {
    const lat = this.lat0 + (y / this.R) * (180 / Math.PI);
    const lon = this.lon0 + (x / (this.R * Math.cos((this.lat0 * Math.PI) / 180))) * (180 / Math.PI);
    return [lat, lon];
  }

  projectPoint(lat, lon) {
    const [x, y] = this.llToXY(lat, lon);
    let best = null;

    for (let i = 0; i < this.routeXY.length - 1; i++) {
      const [x1, y1] = this.routeXY[i];
      const [x2, y2] = this.routeXY[i + 1];
      const vx = x2 - x1;
      const vy = y2 - y1;
      const segLen2 = vx * vx + vy * vy;
      if (segLen2 === 0) continue;

      let t = ((x - x1) * vx + (y - y1) * vy) / segLen2;
      t = Math.max(0, Math.min(1, t));

      const px = x1 + t * vx;
      const py = y1 + t * vy;
      const dist = Math.hypot(x - px, y - py);
      const along = this.cum[i] + t * Math.sqrt(segLen2);

      if (!best || dist < best.dist_m) {
        best = {
          along_m: along,
          dist_m: dist,
          proj_xy: [px, py],
        };
      }
    }

    if (!best) throw new Error("Projection failed.");
    return best;
  }

  sternFromBow(bowLat, bowLon, headingDeg, lengthM) {
    const [x, y] = this.llToXY(bowLat, bowLon);
    const rad = (headingDeg * Math.PI) / 180;
    const sternX = x - lengthM * Math.sin(rad);
    const sternY = y - lengthM * Math.cos(rad);
    return this.xyToLL(sternX, sternY);
  }

  occupiedRange(bowLat, bowLon, headingDeg, lengthM) {
    const [sternLat, sternLon] = this.sternFromBow(bowLat, bowLon, headingDeg, lengthM);
    const bowProj = this.projectPoint(bowLat, bowLon);
    const sternProj = this.projectPoint(sternLat, sternLon);

    const start_m = Math.min(bowProj.along_m, sternProj.along_m);
    const end_m = Math.max(bowProj.along_m, sternProj.along_m);

    return {
      start_m: +start_m.toFixed(2),
      end_m: +end_m.toFixed(2),
      bow_projected_m: +bowProj.along_m.toFixed(2),
      stern_projected_m: +sternProj.along_m.toFixed(2),
      bow_to_axis_dist_m: +bowProj.dist_m.toFixed(2),
      stern_to_axis_dist_m: +sternProj.dist_m.toFixed(2),
      stern_lat: sternLat,
      stern_lon: sternLon,
    };
  }
}

async function extractPortShips() {
  const htmlText = await fetchText(PORT_URL);
  const $ = cheerio.load(htmlText);
  const section = $("#in-port");
  if (!section.length) throw new Error("In Port bölümü bulunamadı.");

  const ships = [];
  const seen = new Set();

  section.find("tbody tr").each((_, row) => {
    const titleEl = $(row).find(".named-title").first();
    const typeEl = $(row).find(".named-subtitle").first();
    const linkEl = $(row).find("a.named-item").first();

    if (!titleEl.length || !typeEl.length || !linkEl.length) return;

    const name = cleanText(titleEl.text());
    const shipType = cleanText(typeEl.text());
    const detailUrl = absoluteUrl(linkEl.attr("href"));

    if (!PASSENGER_KEYWORDS.some((k) => shipType.toLowerCase().includes(k.toLowerCase()))) return;

    const key = `${name}|||${detailUrl}`;
    if (seen.has(key)) return;
    seen.add(key);

    ships.push({ name, type: shipType, detail_url: detailUrl });
  });

  return ships;
}

function parseDjsonFromDetailPage($) {
  const node = $("#djson[data-json]").first();
  if (!node.length) return null;
  const raw = node.attr("data-json") || "";
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(raw.replace(/&quot;/g, '"'));
    } catch {
      return null;
    }
  }
}

function parseKeyValueTables($) {
  const data = {};
  $("table.tpt1, table.aparams, table.spt1, table.spt0fix, table.spt1fix").each((_, table) => {
    $(table).find("tr").each((_, row) => {
      const tds = $(row).find("td").toArray();
      if (tds.length !== 2) return;
      const key = cleanText($(tds[0]).text());
      const value = cleanText($(tds[1]).text());
      if (key && value) data[key] = value;
    });
  });
  return data;
}

function parseVoyageText(summaryText) {
  const out = {};
  let m;

  m = summaryText.match(/The current position of .*? is\s+(.*?)\s+reported/i);
  if (m) out.current_position = cleanText(m[1]);

  m = summaryText.match(/en route to the port of\s+(.*?),\s*and expected to arrive/i);
  if (m) out.destination = cleanText(m[1]);

  m = summaryText.match(/expected to arrive there on\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{2}:\d{2})/i);
  if (m) out.expected_arrival = cleanText(m[1]);

  m = summaryText.match(/built in\s+(\d{4})/i);
  if (m) out.built_year_summary = m[1];

  m = summaryText.match(/is a\s+(.+?)\s+built in/i);
  if (m) out.ship_type_summary = cleanText(m[1]);

  m = summaryText.match(/sailing under the flag of\s+(.+?)\./i);
  if (m) out.flag_summary = cleanText(m[1]);

  return out;
}

async function parseDetailPage(detailUrl) {
  const htmlText = await fetchText(detailUrl);
  const $ = cheerio.load(htmlText);
  const result = { detail_url: detailUrl };

  const h1 = $("h1.title").first();
  const h2 = $("h2.vst").first();
  if (h1.length) result.vessel_name = cleanText(h1.text());
  if (h2.length) result.subtitle = cleanText(h2.text());

  const img = $("img.main-photo").first();
  if (img.length && img.attr("src")) result.photo_url = absoluteUrl(img.attr("src"));

  const summary = $("section.ship-section.text-section p.text2").first();
  if (summary.length) {
    const summaryText = cleanText(summary.text());
    result.summary_text = summaryText;
    Object.assign(result, parseVoyageText(summaryText));
  }

  Object.assign(result, parseKeyValueTables($));

  const djson = parseDjsonFromDetailPage($);
  if (djson) result.ship_cog = djson.ship_cog;

  const voyageBlock = $("h2.bar2#lim").first();
  if (voyageBlock.length) {
    const voyageTable = voyageBlock.nextAll("table.aparams").first();
    if (voyageTable.length) {
      const voyageKV = {};
      voyageTable.find("tr").each((_, row) => {
        const tds = $(row).find("td").toArray();
        if (tds.length !== 2) return;
        const key = cleanText($(tds[0]).text());
        const value = cleanText($(tds[1]).text());
        voyageKV[key] = value;
      });

      result.voyage = {
        predicted_eta: voyageKV["Predicted ETA"] || "",
        distance_time: voyageKV["Distance / Time"] || "",
        course_speed: voyageKV["Course / Speed"] || "",
        current_draught: voyageKV["Current draught"] || "",
        navigation_status: voyageKV["Navigation Status"] || "",
        position_received: voyageKV["Position received"] || "",
        imo_mmsi: voyageKV["IMO / MMSI"] || "",
        callsign: voyageKV["Callsign"] || "",
        ais_type: voyageKV["AIS Type"] || "",
        ais_flag: voyageKV["AIS Flag"] || "",
        length_beam: voyageKV["Length / Beam"] || "",
      };

      const lastPortBox = voyageTable.nextAll("div.vi__stp").first();
      if (lastPortBox.length) {
        const anchor = lastPortBox.find("a._npNa").first();
        const val = lastPortBox.find("div._value").first();
        result.voyage.last_port = anchor.length ? cleanText(anchor.text()) : "";
        result.voyage.last_port_time = val.length ? cleanText(val.text()) : "";
      }
    }
  }

  const particulars = {};
  $("section h2.bar").each((_, h) => {
    if (cleanText($(h).text()) !== "Vessel Particulars") return;
    const partSection = $(h).closest("section");
    partSection.find("table.tpt1 tr").each((_, row) => {
      const tds = $(row).find("td").toArray();
      if (tds.length !== 2) return;
      const key = cleanText($(tds[0]).text());
      const value = cleanText($(tds[1]).text());
      if (key && value) particulars[key] = value;
    });
  });

  result.particulars = particulars;
  return result;
}

async function getShipLocation(mmsi) {
  const url = `${API_BASE}/ml/${mmsi}`;
  const buf = await fetchBuffer(url);

  if (buf.length <= 2) return { success: false, mmsi };

  const flags = buf.readUInt8(0);
  const sar = !!(flags & 0x02);
  const sl = !!(flags & 0x10);

  const sogRaw = buf.readInt16BE(1);
  const lonRaw = buf.readInt32BE(3);
  const latRaw = buf.readInt32BE(7);

  const sog = sogRaw / 10;
  const lon = lonRaw / SCALE;
  const lat = latRaw / SCALE;

  const titleLen = buf.readUInt8(11);
  const title = buf.slice(12, 12 + titleLen).toString("utf8");

  const dOffset = 12 + titleLen;
  const d = buf.length >= dOffset + 4 ? buf.readInt32BE(dOffset) : 0;

  return { success: true, mmsi, lat, lon, sog, sar, sl, title, d };
}

async function fetchHeadingsFromBBox(lat_min, lon_min, lat_max, lon_max) {
  function toRaw(v) {
    return Math.round(v * SCALE);
  }

  const url =
    `${BASE_URL}/api/pub/mp2?bbox=` +
    `${toRaw(lon_min)},${toRaw(lat_min)},${toRaw(lon_max)},${toRaw(lat_max)}` +
    `&zoom=16&mmsi=0&mcbe=1&ref=1`;

  const buf = await fetchBuffer(url);
  const results = {};

  let i = 0;
  while (i < buf.length - 20) {
    try {
      const nameLen = buf.readUInt8(i);
      if (nameLen < 1 || nameLen > 40) {
        i += 1;
        continue;
      }

      const nameEnd = i + 1 + nameLen;
      if (nameEnd >= buf.length) break;

      const rawName = buf.slice(i + 1, nameEnd);
      if (![...rawName].every((c) => c >= 32 && c <= 126)) {
        i += 1;
        continue;
      }

      const name = rawName.toString("ascii").trim();
      const off = nameEnd;
      if (off + 10 > buf.length) break;

      const bow = buf.readUInt16BE(off);
      const stern = buf.readUInt16BE(off + 2);
      const port = buf.readUInt16BE(off + 4);
      const stbd = buf.readUInt16BE(off + 6);
      const heading = buf.readUInt16BE(off + 8);

      const valid =
        bow + stern > 0 && bow + stern <= 600 &&
        port + stbd > 0 && port + stbd <= 120 &&
        port < 70 && stbd < 70 &&
        heading >= 0 && heading <= 359;

      if (valid) {
        results[name.toUpperCase()] = {
          heading,
          length: bow + stern,
          width: port + stbd,
        };
      }
    } catch {
      // ignore parse errors
    }

    i += 1;
  }

  return results;
}

function blockedVenuesForShip(
  ship,
  venues,
  axis,
  {
    minOverlapM = 0.5,
    includeCategories = null,
    excludeCategories = null,
    viewRelevantOnly = true,
    foodOnly = false,
  } = {}
) {
  const shipInterval = axis.occupiedRange(
    ship.bow_lat,
    ship.bow_lon,
    ship.heading_deg,
    ship.length_m
  );

  const s0 = shipInterval.start_m;
  const s1 = shipInterval.end_m;

  const blocked = [];

  for (const v of venues) {
    const cat = String(v.category || "").toLowerCase();

    if (includeCategories && !includeCategories.has(cat)) continue;
    if (excludeCategories && excludeCategories.has(cat)) continue;
    if (viewRelevantOnly && !isViewRelevantVenue(v)) continue;
    if (foodOnly && !isFoodVenue(v)) continue;

    const v0 = parseFloatSafe(v.shore_m_start, 0);
    const v1 = parseFloatSafe(v.shore_m_end, 0);

    const ov = intervalOverlap(s0, s1, v0, v1);
    if (ov >= minOverlapM) blocked.push(v);
  }

  blocked.sort((a, b) => {
    const a0 = parseFloatSafe(a.shore_m_start, 0);
    const b0 = parseFloatSafe(b.shore_m_start, 0);
    if (a0 !== b0) return a0 - b0;
    const a1 = parseFloatSafe(a.shore_m_end, 0);
    const b1 = parseFloatSafe(b.shore_m_end, 0);
    if (a1 !== b1) return a1 - b1;
    return String(a.title_en || a.title_tr || a.id).localeCompare(String(b.title_en || b.title_tr || b.id));
  });

  return {
    ship_interval_m: [Number(s0.toFixed(2)), Number(s1.toFixed(2))],
    blocked_venue_ids: blocked.map((v) => v.id),
    blocked_venues: blocked,
  };
}

async function fetchPortShipsWithBlocking({
  venuesJson = "galataport_venues.json",
  minOverlapM = 0.5,
  foodOnly = false,
  viewRelevantOnly = true,
} = {}) {
  const [startLat, startLon] = dmsToDecimal(START_DMS);
  const [midLat, midLon] = dmsToDecimal(MIDDLE_DMS);
  const [endLat, endLon] = dmsToDecimal(END_DMS);

  const axis = new GalataPortAxis([
    { lat: startLat, lon: startLon },
    { lat: midLat, lon: midLon },
    { lat: endLat, lon: endLon },
  ]);

  let venues = loadVenues(venuesJson);
  if (foodOnly) venues = venues.filter(isFoodVenue);

  console.log("⚓ Port sayfası taranıyor…");
  const ships = await extractPortShips();
  if (!ships.length) {
    console.log("Portta yolcu/cruise gemisi bulunamadı.");
    return [];
  }

  console.log(`   ${ships.length} gemi bulundu.\n`);

  console.log("🧭 Heading verisi çekiliyor (mp2 bbox)…");
  let headingMap = {};
  try {
    headingMap = await fetchHeadingsFromBBox(
      GALATAPORT_BBOX.lat_min,
      GALATAPORT_BBOX.lon_min,
      GALATAPORT_BBOX.lat_max,
      GALATAPORT_BBOX.lon_max
    );
    console.log(`   ${Object.keys(headingMap).length} gemi mp2'de görünüyor.\n`);
  } catch (e) {
    console.log(`   mp2 HATA: ${e.message}\n`);
  }

  const allData = [];

  for (const ship of ships) {
    console.log(`Çekiliyor: ${ship.name} (${ship.type})`);

    const data = await parseDetailPage(ship.detail_url);
    data.port_name = "Istanbul / Galataport";
    data.list_name = ship.name;
    data.list_type = ship.type;

    const voyage = data.voyage || {};
    const mmsi = extractMmsi(voyage.imo_mmsi || "");

    if (mmsi) {
      try {
        data.live_position = await getShipLocation(mmsi);
      } catch (e) {
        data.live_position_error = String(e.message || e);
        data.live_position = null;
      }
    } else {
      data.live_position = null;
      data.live_position_error = "MMSI bulunamadı.";
    }

    const aisName = String(data.vessel_name || ship.name).toUpperCase();
    data.heading_info = headingMap[aisName] || null;

    if (data.live_position && data.live_position.success && data.heading_info) {
      const live = data.live_position;
      const hdg = data.heading_info;

      const shipInput = {
        name: aisName,
        bow_lat: live.lat,
        bow_lon: live.lon,
        heading_deg: hdg.heading,
        length_m: hdg.length,
      };

      const blocked = blockedVenuesForShip(shipInput, venues, axis, {
        minOverlapM,
        viewRelevantOnly,
        foodOnly,
      });

      data.ship_for_blocking = shipInput;
      data.ship_interval_m = blocked.ship_interval_m;
      data.blocked_venue_ids = blocked.blocked_venue_ids;
      data.blocked_venues = blocked.blocked_venues;
    } else {
      data.ship_for_blocking = null;
      data.ship_interval_m = null;
      data.blocked_venue_ids = [];
      data.blocked_venues = [];
    }

    allData.push(data);
  }

  return allData;
}

function printSummary(allData) {
  for (const item of allData) {
    const hdg = item.heading_info || {};
    const live = item.live_position || {};

    console.log("\n" + "=".repeat(100));
    console.log(item.vessel_name || item.list_name || "");
    console.log("=".repeat(100));
    console.log("Type:             ", item.subtitle || item.list_type || "");
    console.log("Photo:            ", item.photo_url || "");
    console.log("Current position: ", item.current_position || "");
    console.log("Destination:      ", item.destination || "");
    console.log("Expected arrival: ", item.expected_arrival || "");
    console.log("Last port:        ", item.voyage?.last_port || "");
    console.log("Last port time:   ", item.voyage?.last_port_time || "");
    console.log("IMO/MMSI:         ", item.voyage?.imo_mmsi || "");
    console.log("Callsign:         ", item.voyage?.callsign || "");
    console.log("AIS type:         ", item.voyage?.ais_type || "");
    console.log("AIS flag:         ", item.voyage?.ais_flag || "");
    console.log("Length/Beam:      ", item.voyage?.length_beam || "");
    console.log("Ship COG:         ", item.ship_cog || "");

    if (hdg && hdg.heading !== undefined) {
      console.log("Heading:          ", `${hdg.heading}°`);
      console.log("Length (mp2):     ", `${hdg.length} m`);
      console.log("Width  (mp2):     ", `${hdg.width} m`);
    } else {
      console.log("Heading:           (mp2'de bulunamadı)");
    }

    if (live && live.success) {
      console.log("Live name:        ", live.title || "");
      console.log("Live lat:         ", live.lat || "");
      console.log("Live lon:         ", live.lon || "");
      console.log("Live SOG:         ", live.sog || "");
    } else {
      console.log("Live position:    ", item.live_position_error || "No live data");
    }

    console.log("Ship interval m:  ", item.ship_interval_m || []);
    console.log("Blocked venue ids: ", item.blocked_venue_ids || []);
    console.log("Particulars:", JSON.stringify(item.particulars || {}, null, 2));
  }

  console.log(`\n${"=".repeat(100)}`);
  console.log(`  Toplam ${allData.length} gemi işlendi.`);
  console.log(`${"=".repeat(100)}\n`);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/ships", async (req, res) => {
  try {
    const foodOnly = String(req.query.food_only || "false").toLowerCase() === "true";
    const viewRelevantOnly = String(req.query.view_relevant_only || "true").toLowerCase() !== "false";
    const minOverlapM = req.query.min_overlap_m ? Number(req.query.min_overlap_m) : 0.5;

    const data = await fetchPortShipsWithBlocking({
      venuesJson: req.query.venues_json || "galataport_venues.json",
      minOverlapM,
      foodOnly,
      viewRelevantOnly,
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err.message || err),
    });
  }
});

async function main() {
  const data = await fetchPortShipsWithBlocking({
    venuesJson: "galataport_venues.json",
    minOverlapM: 0.5,
    foodOnly: false,
    viewRelevantOnly: true,
  });

  printSummary(data);

  const outPath = path.join(process.cwd(), "galataport_ships_with_blocking.json");
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`JSON yazıldı: ${outPath}`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Express server running on http://localhost:${PORT}`);

  if (process.env.RUN_ON_START === "1") {
    try {
      await main();
    } catch (err) {
      console.error("MAIN ERROR:", err);
    }
  }
});
