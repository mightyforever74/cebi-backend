// /opt/fleet/backend/services/tripPdfExporter.js
// ============================================================
// TulipFleet Trip Report PDF Generator  v1.2
// Mart 2026
//
// Public API:
//   generateTripReportPdf({ vehicle, from, to, summary, trips, stops })
//     → PDFDocument — call doc.end() after piping
//
// Kullanım (Fastify):
//   const doc = generateTripReportPdf({ ... });
//   reply.hijack();
//   reply.raw.writeHead(200, { ... });
//   doc.pipe(reply.raw);
//   doc.end();
//
// Font notu:
//   Türkçe karakter desteği için DejaVu Sans kullanılır.
//   Docker (Ubuntu) container'da genellikle mevcuttur.
//   Yoksa fallback olarak Helvetica kullanılır (Türkçe kırılır).
//
// v1.2:
//   - bufferPages:true + switchToPage ile footer
//   - Boş sayfa bug'ı çözüldü
//   - formatDuration: sa/dk
//   - Empty summary: 0 tabanlı
//   - UTC notu
//   - lat/lng explicit null check
//   - reply.hijack() dokümante
// ============================================================

'use strict';

const PDFDocument = require('pdfkit');
const fs = require('fs');

// ── Font discovery ──────────────────────────────────────────
const FONT_PATHS = [
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
];

let fontRegular = null;
let fontBold = null;

try {
  if (fs.existsSync(FONT_PATHS[0])) fontRegular = FONT_PATHS[0];
  if (fs.existsSync(FONT_PATHS[1])) fontBold = FONT_PATHS[1];
} catch (_) { /* Helvetica fallback */ }

const FONT = fontRegular || 'Helvetica';
const FONT_BOLD = fontBold || 'Helvetica-Bold';

// ── Renk paleti ─────────────────────────────────────────────
const COLORS = {
  primary:    '#5E72E4',   // COLORS.PRIMARY — projenin gerçek primary rengi
  dark:       '#212529',   // COLORS.DARK
  muted:      '#8898AA',   // COLORS.SECONDARY (muted text)
  success:    '#2DCE89',   // COLORS.SUCCESS
  white:      '#FFFFFF',
  lightBg:    '#F4F5F7',   // COLORS.LIGHT
  headerBg:   '#5E72E4',   // Header bar = primary
  borderGray: '#E2E8F0',
  rowAlt:     '#F4F5F7',   // COLORS.LIGHT ile uyumlu
};

// ── Sayfa sabitleri ─────────────────────────────────────────
const PAGE = {
  width: 595.28,   // A4
  height: 841.89,
  marginLeft: 40,
  marginRight: 40,
  marginTop: 40,
  marginBottom: 50,
};
PAGE.contentWidth = PAGE.width - PAGE.marginLeft - PAGE.marginRight;
PAGE.contentBottom = PAGE.height - PAGE.marginBottom;

// ── Yardımcılar ─────────────────────────────────────────────

const formatDuration = (ms, zeroAsDash) => {
  if (ms === null || ms === undefined) return '-';
  if (ms <= 0) return zeroAsDash ? '-' : '0dk';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}sa ${m}dk`;
  return `${m}dk`;
};

const formatDistance = (meters, zeroAsDash) => {
  if (meters === null || meters === undefined) return '-';
  if (meters <= 0) return zeroAsDash ? '-' : '0 km';
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
};

const formatTimeShort = (isoStr) => {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '-';
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  } catch (_) { return '-'; }
};

const formatDateRange = (from, to) => {
  const fmt = (iso) => {
    try { return new Date(iso).toISOString().substring(0, 10); }
    catch (_) { return iso; }
  };
  return `${fmt(from)} \u2014 ${fmt(to)}`;
};

const safeStr = (val) => {
  if (val === null || val === undefined) return '-';
  return String(val);
};

const scaleColumns = (columns) => {
  const desired = columns.reduce((s, c) => s + c.width, 0);
  const ratio = PAGE.contentWidth / desired;
  return columns.map((c) => ({
    label: c.label,
    width: Math.floor(c.width * ratio),
    align: c.align,
  }));
};

// ── Tablo çizim motoru ──────────────────────────────────────
const drawTable = (doc, opts) => {
  const {
    x, columns, rows,
    headerBg = COLORS.headerBg,
    rowAltBg = COLORS.rowAlt,
    fontSize = 8,
    headerFontSize = 8,
    rowHeight = 20,
    headerHeight = 24,
  } = opts;

  let y = opts.y;
  let tableStartY = y;
  const tableWidth = columns.reduce((sum, c) => sum + c.width, 0);

  const drawHeader = (atY) => {
    doc.rect(x, atY, tableWidth, headerHeight).fill(headerBg);
    doc.font(FONT_BOLD).fontSize(headerFontSize).fillColor(COLORS.white);
    let hx = x;
    for (const col of columns) {
      doc.text(col.label, hx + 4, atY + 6, {
        width: col.width - 8, align: col.align || 'left', lineBreak: false,
      });
      hx += col.width;
    }
    return atY + headerHeight;
  };

  y = drawHeader(y);

  for (let i = 0; i < rows.length; i++) {
    if (y + rowHeight > PAGE.contentBottom) {
      // Dış çerçeve (mevcut sayfadaki parçası)
      doc.rect(x, tableStartY, tableWidth, y - tableStartY)
         .strokeColor(COLORS.borderGray).lineWidth(1).stroke();

      doc.addPage();
      y = PAGE.marginTop;
      tableStartY = y;
      y = drawHeader(y);
    }

    const row = rows[i];
    const fill = i % 2 === 1 ? rowAltBg : COLORS.white;

    doc.rect(x, y, tableWidth, rowHeight).fill(fill);
    doc.moveTo(x, y + rowHeight).lineTo(x + tableWidth, y + rowHeight)
       .strokeColor(COLORS.borderGray).lineWidth(0.5).stroke();

    doc.font(FONT).fontSize(fontSize).fillColor(COLORS.dark);
    let cx = x;
    for (let j = 0; j < columns.length; j++) {
      doc.text(safeStr(row[j]), cx + 4, y + 5, {
        width: columns[j].width - 8, align: columns[j].align || 'left', lineBreak: false,
      });
      cx += columns[j].width;
    }

    y += rowHeight;
  }

  // Dış çerçeve (son sayfa parçası)
  doc.rect(x, tableStartY, tableWidth, y - tableStartY)
     .strokeColor(COLORS.borderGray).lineWidth(1).stroke();

  return y;
};

// ── Summary kartı ───────────────────────────────────────────
const drawSummaryCard = (doc, y, summary) => {
  const cardX = PAGE.marginLeft;
  const cardW = PAGE.contentWidth;
  const cardH = 70;
  const padding = 12;

  doc.roundedRect(cardX, y, cardW, cardH, 4).fill(COLORS.lightBg);
  doc.roundedRect(cardX, y, cardW, cardH, 4).strokeColor(COLORS.borderGray).lineWidth(1).stroke();

  const metrics = [
    { label: 'Toplam Sefer',     value: safeStr(summary.totalTrips || 0) },
    { label: 'Toplam Mesafe',    value: formatDistance(summary.totalDistanceMeters, false) },
    { label: 'S\u00fcr\u00fc\u015f S\u00fcresi', value: formatDuration(summary.totalDriveTimeMs, false) },
    { label: 'Bekleme S\u00fcresi',  value: formatDuration(summary.totalIdleTimeMs, false) },
  ];

  const metricW = (cardW - padding * 2) / metrics.length;
  let mx = cardX + padding;

  for (let mi = 0; mi < metrics.length; mi++) {
    doc.font(FONT_BOLD).fontSize(16).fillColor(COLORS.primary);
    doc.text(metrics[mi].value, mx, y + padding, { width: metricW, align: 'center', lineBreak: false });

    doc.font(FONT).fontSize(8).fillColor(COLORS.muted);
    doc.text(metrics[mi].label, mx, y + padding + 22, { width: metricW, align: 'center', lineBreak: false });

    if (mi < metrics.length - 1) {
      doc.moveTo(mx + metricW, y + padding).lineTo(mx + metricW, y + cardH - padding)
         .strokeColor(COLORS.borderGray).lineWidth(0.5).stroke();
    }
    mx += metricW;
  }

  return y + cardH;
};

// ── Footer: tüm sayfalara ekle ──────────────────────────────
// bufferPages:true ile tüm içerik yazıldıktan sonra çağrılır.
// switchToPage ile her sayfaya gidip footer çizer.
const _addFooters = (doc, plate) => {
  const range = doc.bufferedPageRange();
  const totalPages = range.count;
  const footerY = PAGE.contentBottom - 12; // Margin sınırı içinde (779)

  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(range.start + i);

    doc.font(FONT).fontSize(7).fillColor(COLORS.muted);
    doc.text(
      `TulipFleet Sefer Raporu \u2014 ${plate}`,
      PAGE.marginLeft, footerY,
      { width: PAGE.contentWidth / 2, align: 'left', lineBreak: false }
    );
    doc.text(
      `Sayfa ${i + 1}/${totalPages}  \u2022  tulipfleet.com`,
      PAGE.marginLeft + PAGE.contentWidth / 2, footerY,
      { width: PAGE.contentWidth / 2, align: 'right', lineBreak: false }
    );
  }
  // flushPages çağrısı yapMIYORUZ.
  // Caller doc.end() çağırdığında pdfkit otomatik flush eder.
};

// ── PUBLIC: PDF üretici ─────────────────────────────────────
/**
 * @param {Object} opts
 * @param {Object} opts.vehicle  - { plate_no }
 * @param {string} opts.from     - ISO 8601
 * @param {string} opts.to       - ISO 8601
 * @param {Object} opts.summary  - { totalTrips, totalDistanceMeters, totalDriveTimeMs, totalIdleTimeMs, pointCount }
 * @param {Array}  opts.trips    - [{ tripNumber, startTime, endTime, durationMs, distanceMeters, pointCount }]
 * @param {Array}  opts.stops    - [{ stopNumber, startTime, endTime, durationMs, centerLat, centerLng }]
 * @returns {PDFDocument} — pipe to reply.raw after reply.hijack(), then call doc.end()
 */
const generateTripReportPdf = (opts) => {
  const { vehicle, from, to, summary, trips, stops } = opts;

  const plate = vehicle?.plate_no || vehicle?.plate || 'Bilinmiyor';
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PAGE.marginTop, bottom: PAGE.marginBottom, left: PAGE.marginLeft, right: PAGE.marginRight },
    info: {
      Title: `TulipFleet Sefer Raporu \u2014 ${plate}`,
      Author: 'TulipFleet',
      Subject: formatDateRange(from, to),
      Creator: 'TulipFleet Trip Engine v1.2',
    },
    bufferPages: true,
  });

  if (fontRegular) doc.registerFont('regular', fontRegular);
  if (fontBold)    doc.registerFont('bold', fontBold);

  let y = PAGE.marginTop;

  // ═══════ HEADER BAR ═══════
  doc.rect(0, 0, PAGE.width, 80).fill(COLORS.primary);

  doc.font(FONT_BOLD).fontSize(22).fillColor(COLORS.white);
  doc.text('TulipFleet', PAGE.marginLeft, 16, { lineBreak: false });

  doc.font(FONT).fontSize(10).fillColor(COLORS.white);
  doc.text('Sefer Raporu', PAGE.marginLeft, 42, { lineBreak: false });

  const rightX = PAGE.width - PAGE.marginRight - 200;
  doc.font(FONT_BOLD).fontSize(14).fillColor(COLORS.white);
  doc.text(plate, rightX, 16, { width: 200, align: 'right', lineBreak: false });

  doc.font(FONT).fontSize(9).fillColor(COLORS.white);
  doc.text(formatDateRange(from, to), rightX, 36, { width: 200, align: 'right', lineBreak: false });

  doc.font(FONT).fontSize(7).fillColor(COLORS.white);
  doc.text(`Olu\u015fturulma: ${now} UTC`, rightX, 52, { width: 200, align: 'right', lineBreak: false });

  y = 95;

  // ═══════ SUMMARY KART ═══════
  doc.font(FONT_BOLD).fontSize(11).fillColor(COLORS.dark);
  doc.text('G\u00fcnl\u00fck \u00d6zet', PAGE.marginLeft, y, { lineBreak: false });
  y += 18;

  y = drawSummaryCard(doc, y, summary);
  y += 8;

  // UTC notu
  doc.font(FONT).fontSize(6.5).fillColor(COLORS.muted);
  doc.text('* T\u00fcm saatler UTC\'dir.', PAGE.marginLeft, y, { lineBreak: false });
  y += 16;

  // ═══════ BOŞ VERİ ═══════
  if (!trips || trips.length === 0) {
    doc.font(FONT).fontSize(11).fillColor(COLORS.muted);
    doc.text('Bu tarih aral\u0131\u011f\u0131nda sefer bulunamad\u0131.', PAGE.marginLeft, y + 20,
      { width: PAGE.contentWidth, align: 'center', lineBreak: false });

    _addFooters(doc, plate);
    return doc;
  }

  // ═══════ TRIP TABLOSU ═══════
  doc.font(FONT_BOLD).fontSize(11).fillColor(COLORS.dark);
  doc.text('Sefer Listesi', PAGE.marginLeft, y, { lineBreak: false });
  y += 18;

  const tripColumns = [
    { label: '#',                          width: 30,  align: 'center' },
    { label: 'Ba\u015flang\u0131\u00e7',  width: 100, align: 'center' },
    { label: 'Biti\u015f',                 width: 100, align: 'center' },
    { label: 'S\u00fcre',                  width: 70,  align: 'center' },
    { label: 'Mesafe',                     width: 70,  align: 'right'  },
    { label: 'Nokta',                      width: 50,  align: 'right'  },
  ];

  const tripRows = trips.map((t) => [
    safeStr(t.tripNumber),
    formatTimeShort(t.startTime),
    formatTimeShort(t.endTime),
    formatDuration(t.durationMs, true),
    formatDistance(t.distanceMeters, true),
    safeStr(t.points ? t.points.length : (t.pointCount || '-')),
  ]);

  y = drawTable(doc, { x: PAGE.marginLeft, y, columns: scaleColumns(tripColumns), rows: tripRows });
  y += 20;

  // ═══════ STOP / IDLE TABLOSU ═══════
  if (stops && stops.length > 0) {
    if (y + 60 > PAGE.contentBottom) {
      doc.addPage();
      y = PAGE.marginTop;
    }

    doc.font(FONT_BOLD).fontSize(11).fillColor(COLORS.dark);
    doc.text('Bekleme / Durak Listesi', PAGE.marginLeft, y, { lineBreak: false });
    y += 18;

    const stopColumns = [
      { label: '#',                          width: 30,  align: 'center' },
      { label: 'Ba\u015flang\u0131\u00e7',  width: 100, align: 'center' },
      { label: 'Biti\u015f',                 width: 100, align: 'center' },
      { label: 'S\u00fcre',                  width: 70,  align: 'center' },
      { label: 'Konum',                      width: 120, align: 'left'   },
    ];

    const stopRows = stops.map((s, i) => {
      const lat = (s.centerLat !== undefined && s.centerLat !== null) ? s.centerLat :
                  (s.latitude !== undefined && s.latitude !== null) ? s.latitude : null;
      const lng = (s.centerLng !== undefined && s.centerLng !== null) ? s.centerLng :
                  (s.longitude !== undefined && s.longitude !== null) ? s.longitude : null;
      const hasCoords = lat !== null && lng !== null;
      const location = hasCoords ? `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}` : '-';

      return [
        String(i + 1),
        formatTimeShort(s.startTime),
        formatTimeShort(s.endTime),
        formatDuration(s.durationMs, true),
        location,
      ];
    });

    y = drawTable(doc, { x: PAGE.marginLeft, y, columns: scaleColumns(stopColumns), rows: stopRows });
  }

  _addFooters(doc, plate);
  return doc;
};

module.exports = { generateTripReportPdf };