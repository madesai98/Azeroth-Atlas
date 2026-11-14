// Which of the objects that stand in the world are trees. The viewer has a switch for them
// (forests hide the ground), and its cutaway treats them differently from everything else.
//
// The game does not say. What it gives to go by:
//   - the name a model carries inside itself ("AshenvaleTree03", "DurotarPalm02") - where it
//     has one. About a tenth have none, and the big canopy trees of Elwynn, Duskwood and
//     Stranglethorn are among those;
//   - for the nameless: the shape. A tree is tall, about as wide as it is tall, and a good part
//     of it is foliage (drawn with cut-out transparency, the way leaves are).
// Checked against the file paths the community has put together for the game's files (not
// needed here, and not complete: this game has trees of its own that are in no such list): of
// some 350 standing trees it misses 5, and it takes 6 things that are not trees (two fountains,
// two giant flowers, a bat roost, a hanging brazier).

export const TREES_VERSION = 1;

const TALL = 6;         // yards: what is lower than this hides nothing (stumps, saplings, bushes)
const NAME = /tree|palm|pine(?!apple)/i;
// "StormwindStreetlamp" has a tree in it too; and what lies on the ground, or is no tree at all
const NOT = /street|treant|portal|banner|huts?\d|facade|stump|log\d|fallen|roots?\d|root_|grass|leaves|mushroom|nest|cactus|smoke|teleport|debris|spine/i;

/**
 * @param shape { name, h, w, leaf }: the model's own name, its height and its greatest width
 *              (yards), and the share of it that is foliage (0..1)
 */
export function isTree(shape) {
  if (!shape || !(shape.h >= TALL)) return false;
  if (shape.name) return NAME.test(shape.name) && !NOT.test(shape.name);
  return shape.h >= 10 && shape.leaf >= 0.35 && shape.w >= 6 && shape.h <= shape.w * 4 && shape.h >= shape.w * 0.35;
}
