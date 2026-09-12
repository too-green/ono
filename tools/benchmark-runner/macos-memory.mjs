/** Parses one byte-formatted macOS footprint report, including dynamic VM categories. */
export function parseFootprint(source) {
  const header = source.match(/Footprint:\s*(\d+) B/);
  const physical = source.match(/phys_footprint:\s*(\d+) B/);
  const peak = source.match(/phys_footprint_peak:\s*(\d+) B/);
  const rows = source.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+) B\s+(\d+) B\s+(\d+) B\s+(\d+) B(?:\s+(\d+) B)?\s+(\d+)\s+(.+?)\s*$/);
    if (!match || match[7] === "---") return [];
    return [{
      dirtyBytes: Number(match[1]),
      swappedBytes: Number(match[2]),
      cleanBytes: Number(match[3]),
      reclaimableBytes: Number(match[4]),
      wiredBytes: match[5] === undefined ? undefined : Number(match[5]),
      regions: Number(match[6]),
      category: match[7],
    }];
  });
  const total = rows.find((row) => row.category === "TOTAL");
  return {
    footprintBytes: numberMatch(header),
    dirtyBytes: total?.dirtyBytes,
    swappedBytes: total?.swappedBytes,
    cleanBytes: total?.cleanBytes,
    reclaimableBytes: total?.reclaimableBytes,
    wiredBytes: total?.wiredBytes,
    regions: total?.regions,
    physicalBytes: numberMatch(physical),
    peakPhysicalBytes: numberMatch(peak),
    categories: rows.filter((row) => row.category !== "TOTAL"),
  };
}

/** Extracts the first numeric capture from one regular-expression result. */
function numberMatch(match) {
  return match ? Number(match[1]) : undefined;
}
