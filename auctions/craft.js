// What a recipe costs to make, at today's prices, and what the thing it makes sells for.
//
// A reagent costs what the auction house's going price is (functions/summary.js says how that
// is reckoned), or, where a vendor sells it (extractor/jobs/recipes.js: `sold`) and asks no
// more, what the vendor asks: nobody pays an auction's price for thread. A reagent that is
// neither for sale at the house nor sold
// by a vendor has no price, and the recipe's cost is then only a part of it: it is said how
// many reagents are missing, and no difference is worked out.
//
// What is NOT in these sums: the auction house's cut and deposit (how much this game takes is
// not in its files), the price of the recipe itself, and whether the thing sells at all, which
// is what TradeSkillMaster's figures beside it are for.

/** What one piece of a reagent costs, and where: [price, 'vendor' | 'auction' | null]. */
export function reagentPrice(id, now, more, sold) {
  const listed = now?.[id];
  const house = listed ? listed[1] || listed[0] || 0 : 0; // (the going price; the lowest asked where there is no going price)
  const vendor = sold.has(Number(id)) ? more?.[id]?.bp ?? 0 : 0;
  if (vendor > 0 && (!house || vendor <= house)) return [vendor, 'vendor'];
  if (house > 0) return [house, 'auction'];
  return [0, null];
}

/**
 * One recipe, costed.
 * @param recipe  [spell, name, skill, learnt at, yellow at, grey at, item made, how many, [[reagent, how many], …], item that teaches it]
 * @param now     the house as last listed: { <id>: [min, mv, n, q] }
 * @param more    items.json `more` (a vendor's price is in it)
 * @param sold    Set of the items a vendor sells
 * @returns { parts: [[item, how many, price of one, where], …], cost, missing, value }
 *          cost: of the reagents that have a price; missing: how many have none; value: what
 *          the things made go for at the house (0: none is for sale)
 */
export function costRecipe(recipe, now, more, sold) {
  let cost = 0, missing = 0;
  const parts = [];
  for (const [item, count] of recipe[8]) {
    const [price, where] = reagentPrice(item, now, more, sold);
    parts.push([item, count, price, where]);
    if (price > 0) cost += price * count; else missing++;
  }
  const listed = recipe[6] ? now?.[recipe[6]] : null;
  const value = listed ? (listed[1] || listed[0] || 0) * Math.max(1, recipe[7]) : 0;
  return { parts, cost, missing, value };
}
