const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value.trim());
}

export function normalizeHexColor(value: string, fallback = "#C1121F"): string {
  const candidate = value.trim();
  return isHexColor(candidate) ? candidate.toUpperCase() : fallback;
}

export function accessibleTextColor(background: string): "#171717" | "#ffffff" {
  const hex = normalizeHexColor(background).slice(1);
  const luminance = [0, 2, 4]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);

  const whiteContrast = 1.05 / (luminance + 0.05);
  const inkContrast = (luminance + 0.05) / 0.059;
  return whiteContrast >= inkContrast ? "#ffffff" : "#171717";
}
