/**
 * =============================================================================
 * Fallen Sword API Endpoints
 * =============================================================================
 * IMPORTANT NOTE:
 * ALL INFO ACQUIRED FROM THESE LINKS COMES IN A JSON FORMAT.
 * The base URL always returns a JSON file with 4 markers: 's', 'r', 't', 'h'.
 */

// Centralized base URL to avoid repetition. Easy to update in one place!
const BASE_APP_URL = "https://www.fallensword.com/app.php?browser=1&v=9999";

// A special base URL for the guild store endpoint.
const BASE_INDEX_URL = "https://www.fallensword.com/index.php?";

// The url used to display most of media files from fallensword
const BASE_MEDIA_URL = "https://cdn2.fallensword.com/";

// The url responsible for fetching world data
const BASE_WORLD_URL = "https://www.fallensword.com/fetchdata.php?";

export const apiEndpoints = {
  // ## OVERALL GAME LINKS ##
  game: {
    updateArchive: `${BASE_APP_URL}&cmd=news&subcmd=viewupdatearchive`,
    newsArchive: `${BASE_APP_URL}&cmd=news&subcmd=viewarchive`,
    superEliteArchive: `${BASE_APP_URL}&cmd=superelite&subcmd=view`,
    cratesArchive: `${BASE_APP_URL}&cmd=crates&subcmd=view`,
    titanDefeatedArchive: `${BASE_APP_URL}&cmd=titan&subcmd=view`,
    activeTitans: `${BASE_APP_URL}&cmd=guild&subcmd=scouttower`,
    fspMarketplace: `${BASE_APP_URL}&cmd=marketplace&subcmd=search`,
    potionBazaar: `${BASE_APP_URL}&cmd=potionbazaar`,
    bountyBoard: `${BASE_APP_URL}&cmd=bounty&subcmd=search`,
    arenaList: `${BASE_APP_URL}&cmd=arena&subcmd=view`, // Note: if type=0, arena is novice. type=1 are joinable.
	joinArena: (arenaId) => `${BASE_INDEX_URL}cmd=arena&subcmd=dojoin&pvp_id=${arenaId}`,
	viewArena: (arenaId) => `${BASE_INDEX_URL}cmd=arena&subcmd=join&pvp_id=${arenaId}`,
    templePrayers: `${BASE_APP_URL}&cmd=temple`,
    shoutbox: `${BASE_APP_URL}&cmd=news&subcmd=fetchshoutbox`,
    ladderResetScoreboard: (bandId) => `${BASE_APP_URL}&cmd=pvpladder&viewing_band_id=${bandId}`,
  },

  // ## GUILD LINKS ##
  guild: {
    hall: `${BASE_APP_URL}&cmd=guild&subcmd=hall`,
    conflicts: `${BASE_APP_URL}&cmd=guild&subcmd=conflicts`,
    advisorReport: `${BASE_APP_URL}&cmd=guild&subcmd=advisor`,
    inventoryReport: `${BASE_APP_URL}&cmd=guild&subcmd=inventory&subcmd2=report`,
    log: `${BASE_APP_URL}&cmd=guild&subcmd=log`,
    // This endpoint is unique and uses a different base URL.
    store: `${BASE_INDEX_URL}cmd=guild&subcmd=fetchinv`,
    // Functions for endpoints that require a guild_id or other parameters.
    relicsById: (guildId) => `${BASE_APP_URL}&cmd=guild&subcmd=reliclist&guild_id=${guildId}`,
    listByLetter: (letter) => `${BASE_APP_URL}&cmd=guild&subcmd=atoz&letter=${letter}`,
    basicInfoById: (guildId) => `${BASE_APP_URL}&cmd=guild&guild_id=${guildId}`,
    membersRankInfoById: (guildId) => `${BASE_APP_URL}&cmd=guild&subcmd=ranks&subcmd2=view&guild_id=${guildId}`,
  },

  // ## PLAYER LINKS ##
  player: {
    privateMessages: `${BASE_APP_URL}&cmd=privatemessage&type=1`,
    inventory: `${BASE_APP_URL}&cmd=profile&subcmd=loadinventory`,
	components: `${BASE_APP_URL}&cmd=profile&subcmd=loadcomponents`,
    activeBuffs: (playerId) => `${BASE_APP_URL}&cmd=profile&subcmd=skills&player_id=${playerId}`,
    details: (playerId) => `${BASE_APP_URL}&cmd=profile&subcmd=details&player_id=${playerId}`,
	ownDetails: `${BASE_APP_URL}&cmd=profile&subcmd=view`,
	profileImg: (playerID) => `${BASE_MEDIA_URL}avatars/${playerID}.png`,
	useItem: (inventoryID) => `${BASE_APP_URL}&cmd=profile&subcmd=useitem&inventory_id=${inventoryID}`,
	equipItem: (inventoryID) => `${BASE_INDEX_URL}cmd=profile&subcmd=equipitem&inventory_id=${inventoryID}`,
	availableBuffs: `${BASE_APP_URL}&cmd=skills`,
	returnPlayerID: (playerUsername) => `${BASE_INDEX_URL}cmd=export&subcmd=profile&player_username=${playerUsername}`,
	removeBuff: (skillID) => `${BASE_APP_URL}&cmd=profile&subcmd=removeskill&skill_id=${skillID}`,
	inventItem: (recipeID) => `${BASE_APP_URL}&cmd=inventing&subcmd=doinvent&recipe_id=${recipeID}`,
	combatSets: `${BASE_APP_URL}&cmd=profile&subcmd=viewcombatset`,
  },
  
  // ## WORLD LINKS ##
  world: {
	  fetchLocation: `${BASE_WORLD_URL}a=-1&d=1409&passback=kta`,
	  fetchWorldMap: `${BASE_WORLD_URL}a=-1&d=81&passback=wln`,
	  attack: (creatureID) => `${BASE_WORLD_URL}a=2&d=1683&id=${creatureID}&passback=kmn`,
	  move: (x, y) => `${BASE_WORLD_URL}a=4&d=1153&x=${x}&y=${y}&passback=mvn`,
	  travel: `${BASE_WORLD_URL}a=5&d=1535&id=1566&passback=tmn`,
  },

  // ## RANKING LINKS ##
  rankings: {
    player: {
      xp: `${BASE_APP_URL}&cmd=toprated&subcmd=xp`,
      gold: `${BASE_APP_URL}&cmd=toprated&subcmd=gold`,
      killstreak: `${BASE_APP_URL}&cmd=toprated&subcmd=killstreak`,
      bounties: `${BASE_APP_URL}&cmd=toprated&subcmd=bounties`,
      risingStars: `${BASE_APP_URL}&cmd=toprated&subcmd=risingstars`,
      arena: `${BASE_APP_URL}&cmd=toprated&subcmd=arena`,
      superElites: `${BASE_APP_URL}&cmd=toprated&subcmd=superelites`,
      smasher: `${BASE_APP_URL}&cmd=toprated&subcmd=smasher`,
    },
    guild: {
      xp: `${BASE_APP_URL}&cmd=toprated&subcmd=guildxp`,
      gold: `${BASE_APP_URL}&cmd=toprated&subcmd=guildgold`,
      rating: `${BASE_APP_URL}&cmd=toprated&subcmd=guildladder`,
      tkp: `${BASE_APP_URL}&cmd=toprated&subcmd=guildtitans`,
    },
  },
  currency: {
		type: (currencyType) => `${BASE_MEDIA_URL}currency/${currencyType}.png`,
  },
  items: {
		displayImage: (itemId) => `${BASE_MEDIA_URL}items/${itemId}.gif`,
  },
};