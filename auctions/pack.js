// How a house's prices are written in the Atlas database: one text.
//
//   { <id>: [a, b, …] }   ↔   "id,a,b;id,a,b;…"
//
// with every number in base 36 (0-9 then a-z: 1295 is "zz"), because the database sends nothing
// compressed and these are fetched often.

const n36 = (v) => Math.max(0, Math.round(Number(v) || 0)).toString(36);

/** { id: [a, b, …] } → "id,a,b;…" */
export function pack(items) {
  const parts = [];
  for (const [id, row] of Object.entries(items)) parts.push(`${n36(id)},${row.map(n36).join(',')}`);
  return parts.join(';');
}

/** and back. Anything that is not a row of whole numbers is left out. */
export function unpack(text) {
  const items = {};
  if (typeof text !== 'string' || !text) return items;
  for (const part of text.split(';')) {
    if (!/^[0-9a-z]+(,[0-9a-z]+)+$/.test(part)) continue; // (parseInt alone would read "hello world" as a number)
    const nums = part.split(',').map((s) => parseInt(s, 36));
    if (nums.some((v) => !Number.isSafeInteger(v))) continue;
    items[nums[0]] = nums.slice(1);
  }
  return items;
}
