// What one auction house holds, item by item. (Part of the scheduled function: index.js.)
//
// Blizzard's list is every auction on its own (tens of thousands a house). What is kept of it is
// one line per item:
//
//   min   the lowest price asked for one piece (copper). An auction that can only be bid on has no
//         such price: it is counted, and that is all.
//   mv    the "going price": what the cheap end of the market asks, with the oddities left out
//         (below). One seller asking a tenth of everybody else for one piece moves `min`, not this.
//   n     how many auctions
//   q     how many pieces
//
// The going price, worked out from every piece for sale, cheapest first:
//   1. the cheapest 15% of the pieces are taken (at least one);
//   2. more are taken, up to 30%, for as long as each costs no more than 1.2 times the one before
//      (where the price jumps, the cheap end is over);
//   3. their average is taken; then any of them further from it than one and a half times their
//      spread (standard deviation) are left out, and the average is taken again.
// This is the way of reckoning TradeSkillMaster has described for its "market value" of one
// scan, so the two can be held against each other; the code is this project's own.
//
// An item with a random ending ("... of the Monkey") is one item here whatever its ending; the
// endings are in the auction's `bonus_lists`, and `variants` keeps them apart for whoever asks.

/** The price of one piece: an auction's buyout over what is in it, or a commodity's unit price. */
const pieceOf = (a) => (a.unit_price > 0 ? a.unit_price : a.buyout > 0 ? a.buyout / Math.max(1, a.quantity || 1) : 0);

export function goingPrice(lots) {
  // lots: [[price of one piece, pieces], …] sorted by price
  let total = 0;
  for (const [, q] of lots) total += q;
  if (!total) return 0;
  const low = Math.max(1, Math.round(total * 0.15)), high = Math.max(1, Math.round(total * 0.3));
  const taken = [];
  let count = 0, before = 0;
  for (const [price, q] of lots) {
    if (count >= high) break;
    if (count >= low && before > 0 && price > before * 1.2) break;
    const take = Math.min(q, high - count);
    taken.push([price, take]);
    count += take;
    before = price;
  }
  const mean = (list) => { let s = 0, c = 0; for (const [p, q] of list) { s += p * q; c += q; } return c ? s / c : 0; };
  const avg = mean(taken);
  let varsum = 0;
  for (const [p, q] of taken) varsum += (p - avg) ** 2 * q;
  const dev = Math.sqrt(varsum / count);
  const kept = taken.filter(([p]) => Math.abs(p - avg) <= dev * 1.5 + 1e-9);
  return Math.round(mean(kept.length ? kept : taken));
}

/**
 * @param auctions     the house's auctions as Blizzard lists them ({ item: { id, bonus_lists }, buyout, bid, quantity })
 * @param commodities  and what is sold by the piece ({ item: { id }, unit_price, quantity })
 * @param variants     also keep each random ending apart, under "<item>:<bonus ids>"
 * @returns Map<item id (or variant key), { min, mv, n, q }>
 */
export function summarise(auctions = [], commodities = [], { variants = false } = {}) {
  const by = new Map();
  const add = (key, a) => {
    let e = by.get(key);
    if (!e) by.set(key, e = { n: 0, q: 0, lots: [] });
    const q = Math.max(1, a.quantity || 1);
    e.n++;
    e.q += q;
    const price = pieceOf(a);
    if (price > 0) e.lots.push([price, q]);
  };
  for (const list of [auctions, commodities]) {
    for (const a of list) {
      const id = a?.item?.id;
      if (!Number.isInteger(id) || id <= 0) continue;
      add(id, a);
      if (variants && Array.isArray(a.item.bonus_lists) && a.item.bonus_lists.length) add(`${id}:${[...a.item.bonus_lists].sort((x, y) => x - y).join('.')}`, a);
    }
  }
  const out = new Map();
  for (const [key, e] of by) {
    e.lots.sort((x, y) => x[0] - y[0]);
    out.set(key, { min: e.lots.length ? Math.max(1, Math.floor(e.lots[0][0])) : 0, mv: goingPrice(e.lots), n: e.n, q: e.q });
  }
  return out;
}
