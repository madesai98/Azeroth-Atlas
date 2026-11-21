-- Azeroth Atlas: what quests ask after.
-- Written by tools/make-quest-asks.mjs from QuestieDB 1.1.4: do not edit by hand.
--
-- The professions and skills, the factions and the spells that some quest wants a character
-- to have, to stand well with, or to know (a profession's specialisations among the spells),
-- by the game's numbers for them. What they are for: Self.lua.
local shared = AzerothAtlas
if type(shared) ~= "table" then return end

shared.QuestAsks = {
  skills = {
    129, 164, 165, 171, 182, 185, 186, 197, 202, 333, 356, 393,
  },
  factions = {
    21, 59, 72, 87, 92, 93, 270, 349, 369, 470, 509, 510, 529, 576, 577, 589,
    609, 729, 730, 889, 890, 909, 910, 2586, 2587, 2798, 2799,
  },
  spells = {
    9787, 9788, 10656, 10658, 10660, 17039, 17040, 17041, 20219, 20222, 26797, 26798, 26801, 28672, 28675, 28677,
    1229432, 1229504, 1229517, 1229705, 1229745, 1230117, 1230161, 1230171, 1230564, 1230643, 1230656, 1263425,
  },
}
