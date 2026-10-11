/**
 * routes/companyBrandingHelpers.js
 *
 * Müşteri Takip Portalı (§10, MVP-2 kalan) — şirket markalaması (logo + renk).
 * Harita Dokümanı v2 kapsamı dışında, TODO_ACTIVE.md §10 "MVP-2 kalan:
 * ... markalı sayfa (logo/renk)" maddesine karşılık gelir.
 *
 * Saklama: ek migration gerektirmeden `companies.settings` JSONB'sinde
 * `settings.branding = {logoUrl, brandColor}` olarak saklanır. `settings`
 * alanı zaten superadmin şirket oluşturma akışında max_vehicles/max_drivers
 * için kullanılıyor (server.js) — bu modül o diğer anahtarları EZMEDEN
 * sadece `branding` alt-anahtarını günceller (read-merge-write).
 *
 * Güvenlik: brandColor yalnız #RRGGBB formatında, logoUrl yalnız https://
 * ile kabul edilir (javascript:/data: URI veya http:// reddedilir — hem
 * CSS injection hem mixed-content/XSS riskini publicTrack.js'in render
 * aşamasına taşımadan burada kapatır). Geçersiz/eksik değer DB okunurken
 * sessizce default'a düşer (sayfa asla bozuk CSS/URL ile render edilmez);
 * ama YAZARKEN (updateCompanyBranding) geçersiz değer sert biçimde
 * reddedilir (BrandingValidationError) — kullanıcıya hata net dönmeli.
 */

const DEFAULT_BRAND_COLOR = "#5E72E4";
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const HTTPS_URL_RE = /^https:\/\/\S+$/;

class BrandingValidationError extends Error {}

function parseSettings(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function resolveBranding(companyRow) {
  if (!companyRow) {
    return {
      companyName: null,
      logoUrl: null,
      brandColor: DEFAULT_BRAND_COLOR,
      isDefault: true,
    };
  }

  const settings = parseSettings(companyRow.settings);
  const branding =
    settings.branding && typeof settings.branding === "object"
      ? settings.branding
      : {};

  const logoUrl =
    typeof branding.logoUrl === "string" && HTTPS_URL_RE.test(branding.logoUrl)
      ? branding.logoUrl
      : null;
  const brandColor =
    typeof branding.brandColor === "string" &&
    HEX_COLOR_RE.test(branding.brandColor)
      ? branding.brandColor
      : DEFAULT_BRAND_COLOR;

  return {
    companyName: companyRow.name || null,
    logoUrl,
    brandColor,
    isDefault: !logoUrl && brandColor === DEFAULT_BRAND_COLOR,
  };
}

async function getCompanyBranding(client, companyId) {
  const { rows } = await client.query(
    "SELECT name, settings FROM companies WHERE id = $1",
    [companyId]
  );
  return resolveBranding(rows[0] || null);
}

function validateBrandingInput(input) {
  const errors = [];
  const { logoUrl, brandColor } = input || {};

  if (
    logoUrl !== undefined &&
    logoUrl !== null &&
    logoUrl !== "" &&
    !HTTPS_URL_RE.test(logoUrl)
  ) {
    errors.push("logoUrl https:// ile başlayan geçerli bir URL olmalı");
  }
  if (
    brandColor !== undefined &&
    brandColor !== null &&
    brandColor !== "" &&
    !HEX_COLOR_RE.test(brandColor)
  ) {
    errors.push("brandColor #RRGGBB formatında olmalı (örn. #5E72E4)");
  }

  return errors;
}

async function updateCompanyBranding(client, companyId, input) {
  const errors = validateBrandingInput(input);
  if (errors.length) {
    throw new BrandingValidationError(errors.join("; "));
  }

  const { rows } = await client.query(
    "SELECT settings FROM companies WHERE id = $1",
    [companyId]
  );
  if (!rows.length) {
    throw new BrandingValidationError("Şirket bulunamadı");
  }

  const currentSettings = parseSettings(rows[0].settings);
  const nextBranding = { ...(currentSettings.branding || {}) };

  if (input.logoUrl !== undefined) {
    nextBranding.logoUrl = input.logoUrl || null;
  }
  if (input.brandColor !== undefined) {
    nextBranding.brandColor = input.brandColor || null;
  }

  const nextSettings = { ...currentSettings, branding: nextBranding };

  const { rows: updated } = await client.query(
    "UPDATE companies SET settings = $1 WHERE id = $2 RETURNING name, settings",
    [JSON.stringify(nextSettings), companyId]
  );

  return resolveBranding(updated[0]);
}

module.exports = {
  DEFAULT_BRAND_COLOR,
  resolveBranding,
  getCompanyBranding,
  updateCompanyBranding,
  validateBrandingInput,
  BrandingValidationError,
};
