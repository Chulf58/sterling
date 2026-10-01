// FROZEN ORACLE, test fixture only: assembleDelivery exactly as it shipped at
// 8965c63, before the named hold-back changed (board 6c0c848f sub-item 4). The
// differential fuzz in h20-decision-crowd-out.test.mjs asserts the live
// assembler never renders fewer '+N more' names than this one. Generated
// mechanically from `git show 8965c63:scripts/hooks/lib/delivery.mjs`: the
// function and the two byte helpers it calls, comment lines removed, code
// unchanged. Never edit it to track the live code.
export const DELIVERY_TRANSPORT_VISIBLE_BYTES = 10000;

function byteLen(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8');
}

function clipToBytes(text, maxBytes) {
  const s = String(text ?? '');
  if (maxBytes <= 0) return '';
  if (byteLen(s) <= maxBytes) return s;
  const ELLIPSIS = '…';
  const ellipsisBytes = byteLen(ELLIPSIS);
  const room = maxBytes > ellipsisBytes ? maxBytes - ellipsisBytes : 0;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const chBytes = byteLen(ch);
    if (used + chBytes > room) break;
    out += ch;
    used += chBytes;
  }
  return room > 0 ? `${out}${ELLIPSIS}` : out;
}

export function assembleDelivery(parts, capBytes, { sep = '\n\n', aggregateLabel } = {}) {
  const items = (parts ?? [])
    .filter((part) => part && typeof part.text === 'string' && part.text)
    .map((part) => ({
      ...part,
      kind: part.kind === 'hazard' ? 'hazard' : 'ordinary',
      contentClass: part.contentClass ?? 'chrome',
      pinned: part.kind === 'hazard' ? true : !!part.pinned,
    }));

  const idsOf = (part) => part.identities ?? (part.identity ? [{ identity: part.identity, revision: part.revision, name: part.name }] : []);
  const disclosureIdsOf = (part) => part.disclosureIdentities ?? idsOf(part);
  const dedupeEntries = (entries) => {
    const seen = new Set();
    const out = [];
    for (const e of entries) {
      if (!e?.identity) continue;
      const key = `${e.identity}\u0000${e.revision}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ identity: e.identity, revision: e.revision });
    }
    return out;
  };
  const creditsFor = (survivors) => {
    const emittedSubstance = [];
    const emittedDiscovery = [];
    for (const part of survivors) {
      if (part.contentClass !== 'substance' && part.contentClass !== 'discovery') continue;
      const bucket = part.contentClass === 'substance' ? emittedSubstance : emittedDiscovery;
      for (const entry of idsOf(part)) {
        if (entry?.identity) bucket.push({ identity: entry.identity, revision: entry.revision });
      }
    }
    return { emittedSubstance, emittedDiscovery };
  };

  const bytes = (text) => byteLen(text);
  const isHazard = (part) => part.kind === 'hazard';
  const isChrome = (part) => part.kind !== 'hazard' && part.pinned;

  const ordinaryCeiling = capBytes > 0 ? Math.min(capBytes, DELIVERY_TRANSPORT_VISIBLE_BYTES) : DELIVERY_TRANSPORT_VISIBLE_BYTES;

  const selected = new Map();
  const omitted = [];
  const output = () => items.flatMap((part) => (selected.has(part) ? [selected.get(part).text] : []));
  const totalBytes = () => bytes(output().join(sep));
  const hazardBytesUsed = () =>
    [...selected.entries()].reduce((sum, [part, sel]) => sum + (isHazard(part) ? bytes(sel.text) : 0), 0);
  const ordinaryBytesUsed = () => Math.max(0, totalBytes() - hazardBytesUsed());
  const fitsOrdinaryCap = (extra = 0) => ordinaryBytesUsed() + extra <= ordinaryCeiling;
  const fitsTransport = (extra = 0) => totalBytes() + extra <= DELIVERY_TRANSPORT_VISIBLE_BYTES;
  const pointerFor = (part) => part.pointer || '';
  const fullPointerFor = (part) => part.pointerWhenFull || pointerFor(part);

  const tryDegradeOrdinary = (part, fitsFn) => {
    selected.set(part, { text: part.text, full: true });
    if (fitsFn('whole')) return;
    selected.delete(part);

    const ptr = pointerFor(part);
    const suffix = part.suffix || ptr;
    if (suffix) {
      const lines = part.text.split('\n');
      const carriesSuffix = lines[0] === suffix;
      const render = (candidate) => (carriesSuffix ? candidate : `${candidate}\n${suffix}`);
      let clipped = '';
      let best = '';
      let bestLines = 0;
      for (const line of lines) {
        const candidate = clipped ? `${clipped}\n${line}` : line;
        selected.set(part, { text: render(candidate), full: false });
        if (!fitsFn('excerpt')) break;
        clipped = candidate;
        best = render(candidate);
        bestLines += 1;
      }
      if (best && bestLines === 1 && lines.length > 1 && part.suffix && part.suffix !== ptr) {
        selected.set(part, { text: ptr, full: false });
        if (ptr && fitsFn('pointer')) return;
        selected.delete(part);
        omitted.push(part);
        return;
      }
      if (best) {
        selected.set(part, { text: best, full: false });
        return;
      }
      selected.delete(part);
      selected.set(part, { text: ptr, full: false });
      if (ptr && fitsFn('pointer')) return;
      selected.delete(part);
    }
    omitted.push(part);
  };

  const tryDegradeHazard = (part) => {
    selected.set(part, { text: part.text, full: true });
    if (fitsTransport()) return;
    selected.delete(part);
    const ptr = bytes(part.text) > DELIVERY_TRANSPORT_VISIBLE_BYTES ? pointerFor(part) : fullPointerFor(part);
    if (ptr) {
      selected.set(part, { text: ptr, full: false });
      if (fitsTransport()) return;
      selected.delete(part);
    }
    omitted.push(part);
  };

  for (const part of items) if (isChrome(part)) tryDegradeOrdinary(part, () => fitsOrdinaryCap() && fitsTransport());
  for (const part of items) if (isHazard(part)) tryDegradeHazard(part);

  const idsForDisclosure = (part) => {
    const tagged = disclosureIdsOf(part).map((e) => e.identity).filter(Boolean);
    if (tagged.length) return tagged;
    return [...String(part.pointer || part.text).matchAll(/knowledge_get\s+([^\s\])]+)/g)].map((m) => m[1]);
  };
  const disclosureEntries = (list) => {
    const names = new Map();
    for (const e of list.flatMap(disclosureIdsOf)) {
      if (e?.identity && typeof e.name === 'string' && e.name.trim() && !names.has(e.identity)) {
        names.set(e.identity, clipToBytes(e.name.replace(/\s+/g, ' ').trim(), 80));
      }
    }
    return [...new Set(list.flatMap(idsForDisclosure))].map((id) => ({ id8: id.slice(0, 8), name: names.get(id) }));
  };
  const disclosureCount = (list) => dedupeEntries(list.flatMap(disclosureIdsOf)).length || list.length;
  const renderDisclosure = (count, entries) => {
    const prefix = `+${count} more records: knowledge_query`;
    return entries.length
      ? `${prefix}; knowledge_get ${entries.map((e) => (e.name ? `${e.name} (${e.id8})` : e.id8)).join(' ')}`
      : `${prefix}; knowledge_get`;
  };
  const disclosureSize = (list, named) => {
    const custom = aggregateLabel ? bytes(aggregateLabel(disclosureCount(list), disclosureEntries(list).map((e) => e.id8))) : Infinity;
    return custom <= ordinaryCeiling
      ? custom
      : bytes(renderDisclosure(disclosureCount(list), disclosureEntries(list).map((e) => (named ? e : { id8: e.id8 }))));
  };
  const sepCost = (renderedBefore) => (renderedBefore > 0 ? bytes(sep) : 0);

  const ordinaryParts = items.filter((part) => !isHazard(part) && !isChrome(part));
  const baseOmitted = [...omitted];
  const reserved = new Map();
  const placeOrdinary = (disclosure) => {
    for (const part of ordinaryParts) selected.delete(part);
    omitted.length = 0;
    omitted.push(...baseOmitted);
    reserved.clear();
    let rendered = selected.size;
    let room = Math.min(ordinaryCeiling - ordinaryBytesUsed(), DELIVERY_TRANSPORT_VISIBLE_BYTES - totalBytes());
    for (const part of ordinaryParts) {
      const ptr = pointerFor(part);
      if (!ptr) continue;
      const cost = bytes(ptr) + sepCost(rendered);
      if (cost > room) continue;
      reserved.set(part, cost);
      rendered += 1;
      room -= cost;
    }
    const roomFor = (size) => (size > 0 ? Math.max(0, Math.min(room, size + bytes(sep))) : 0);
    const disclosureRoom = { whole: roomFor(disclosure.ids), excerpt: roomFor(disclosure.named), pointer: 0 };
    ordinaryParts.forEach((part, i) => {
      const later = ordinaryParts.slice(i + 1).reduce((sum, next) => sum + (reserved.get(next) ?? 0), 0);
      tryDegradeOrdinary(part, (stage) => {
        const extra = later + disclosureRoom[stage];
        return fitsOrdinaryCap(extra) && fitsTransport(extra);
      });
    });
  };
  {
    let wanted = { ids: 0, named: 0 };
    placeOrdinary(wanted);
    for (let pass = 0; pass < 3 && omitted.length; pass++) {
      const need = { ids: disclosureSize(omitted, false), named: disclosureSize(omitted, true) };
      if (need.ids <= wanted.ids && need.named <= wanted.named) break;
      wanted = { ids: Math.max(need.ids, wanted.ids), named: Math.max(need.named, wanted.named) };
      placeOrdinary(wanted);
    }
  }

  if (omitted.length) {
    const aggregatePart = { kind: 'ordinary', contentClass: 'chrome', text: '' };
    items.push(aggregatePart);
    const aggregate = () => {
      const count = disclosureCount(omitted);
      const entries = disclosureEntries(omitted);
      if (aggregateLabel) {
        const ids = entries.map((e) => e.id8);
        let line = aggregateLabel(count, ids);
        while (ids.length && bytes(line) > ordinaryCeiling) {
          ids.pop();
          line = aggregateLabel(count, ids);
        }
        if (bytes(line) <= ordinaryCeiling) return line;
      }
      const sepBytes = sepCost([...selected.keys()].filter((part) => part !== aggregatePart).length);
      const room = Math.min(ordinaryCeiling - ordinaryBytesUsed() - sepBytes, DELIVERY_TRANSPORT_VISIBLE_BYTES - totalBytes() - sepBytes);
      let line = renderDisclosure(count, entries);
      for (let i = entries.length - 1; i >= 0 && bytes(line) > room; i--) {
        if (!entries[i].name) continue;
        entries[i].name = undefined;
        line = renderDisclosure(count, entries);
      }
      while (entries.length && bytes(line) > ordinaryCeiling) {
        entries.pop();
        line = renderDisclosure(count, entries);
      }
      return line;
    };
    while (true) {
      const text = aggregate();
      aggregatePart.text = text;
      selected.set(aggregatePart, { text, full: false });
      const ordinaryOk = fitsOrdinaryCap();
      const transportOk = fitsTransport();
      if (ordinaryOk && transportOk) break;
      selected.delete(aggregatePart);
      const evictable = [...items].reverse().filter((part) => part !== aggregatePart && !isHazard(part) && selected.has(part));
      const last =
        evictable.find((part) => !isChrome(part) && !reserved.has(part)) ??
        evictable.find((part) => !isChrome(part)) ??
        evictable[0];
      const degradable = !transportOk
        ? [...items].reverse().find((part) => isHazard(part) && selected.has(part) && selected.get(part).full && pointerFor(part))
        : null;
      if (last && (!isChrome(last) || !degradable)) {
        selected.delete(last);
        omitted.push(last);
        continue;
      }
      if (degradable) {
        selected.set(degradable, { text: fullPointerFor(degradable), full: false });
        continue;
      }
      selected.set(aggregatePart, { text, full: false });
      break;
    }
  }

  const survivors = items.filter((part) => selected.has(part) && selected.get(part).full);
  const { emittedSubstance, emittedDiscovery } = creditsFor(survivors);
  const omittedEntries = dedupeEntries(omitted.flatMap(disclosureIdsOf));
  const partial = items.some((part) => selected.has(part) && !selected.get(part).full);
  return {
    text: output().join(sep),
    emittedSubstance,
    emittedDiscovery,
    omitted: omittedEntries,
    omittedCount: omittedEntries.length,
    degraded: omitted.length > 0 || partial,
  };
}
