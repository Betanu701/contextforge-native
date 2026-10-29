import type { DatabaseSync } from 'node:sqlite';

/**
 * Deterministic Background English Prose Lexicon (`lexicon_priors`):
 * Populated once into SQLite on database initialization (`ensureLexiconPriors`).
 *
 * Purpose:
 * - Provides O(1) SQLite and in-memory lookup for common English prose words
 *   (tiered by corpus frequency: Tier 1 = ultra-common function/filler words,
 *   Tier 2 = common conversational/question verbs & adjectives, Tier 3 = general
 *   analytical/academic prose nouns & modifiers).
 * - Prevents common English prose words in questions or issue descriptions
 *   (e.g., "mainly", "important", "provides", "library", "documents", "realistic",
 *   "factors", "following", "correctly") from masquerading as rare technical or
 *   domain identifiers during BM25 / IDF ranking—unless they are explicitly bound
 *   as an AST symbol definition or import in `symbol_bm25_index`.
 */
export const LEXICON_PRIORS_VERSION = 'lexicon-priors-v1';

const TIER1_FUNCTION_WORDS = `
a about above across after again against all almost alone along already also although always am among an and another any anybody anyone anything anywhere are area areas around as ask asked asking asks at away
b back backed backing backs be became because become becomes been before began behind being beings best better between big both이지만 but by
c came can cannot case cases certain certainly clear clearly come could
d did differ different differently do does done down downed downing downs during
e each early either end ended ending ends enough even evenly ever every everybody everyone everything everywhere
f face faces fact facts far felt few find finds first for four from full fully further furthered furthering furthers
g gave general generally get gets give given gives go going good goods got great greater greatest group grouped grouping groups
h had has have having he her here herself high higher highest him himself his how however
i if important in interest interested interesting interests into is it its itself
j just
k keep keeps kind knew know known knows
l large largely last later latest least less let lets like likely long longer longest
m made make making man many may me member members men might more most mostly mr mrs much must my myself
n necessary need needed needing needs never new newer newest next no nobody non noone not nothing now nowhere number numbers
o of off often old older oldest on once one only open opened opening opens or order ordered ordering orders other others our out over
p part parted parting parts per perhaps place places point pointed pointing points possible present presented presenting presents problem problems put puts
q quite
r rather really right room rooms
s said same saw say says second seconds see seem seemed seeming seems sees several shall she should show showed showing shows side sides since small smaller smallest so some somebody someone something somewhere state states still such sure
t take taken takes than that the their them then there therefore these they thing things think thinks this those though thought thoughts three through thus to today together too took toward turn turned turning turns two
u under until up upon us use used uses using
v very
w want wanted wanting wants was way ways we well wells went were what whatever when where whether which while who whole whom whose why will with within without work worked working works would
y year years yet you young younger youngest your yours
`.trim().split(/\s+/);

const TIER2_PROSE_VERBS_MODIFIERS = `
able accept accepted accepting accepts according achieve achieved achieves achieving actual actually add added adding addition additional address addressed addresses addressing adjust adjusted adjusting allow allowed allowing allows appear appeared appearing appears apply applied applies applying approach approaches appropriate approximately
assume assumed assumes assuming attempt attempted attempting attempts available average avoid avoided avoiding
base based bases basic basically become becoming begin beginning begins believe believed believes belong belongs below beside besides beyond brief briefly bring brings broad broadly build building builds built
call called calling calls capable capture captured captures care careful carefully carry carried carries cause caused causes causing center centered central certain change changed changes changing check checked checking checks choice choices choose chosen cite cited citing claim claimed claims clarify classic clean clear close closely closer closest
collect collected collecting collection combine combined combines combining common commonly compare compared compares comparing complete completely completion complexia complicated component components comprehensive concern concerned concerning conclude concluded conclusion condition conditions conduct conducted confirm confirmed connect connected connection consider considered considering consist consists constant constantly construct constructed construction contain contained containing contains content contents continue continued continues continuing Continuous contract contrast contribute contributed contribution control controlled controlling controls convert converted converting correct correctly correspond corresponding cost costs count counted create created creates creating critical crucial current currently custom
data date dates deal dealing deals decide decided decision declare declared default define defined defines defining definition degree delay deliver delivered delivery demand demonstrate demonstrated department depend depending depends describe described describes describing description design designed designing designs detail detailed details determine determined determines determining develop developed developing development device devices difference differences difficult difficulty direct direction directly disable disabled discover discovered discuss discussed discussion display displayed distinct distribute distributed distribution divide divided document documentation documented documents domain double
easily easy effect effective effectively effects effort efforts element elements eliminate enable enabled enables encounter encourage 에너지 engine engineer engineering enhance enhanced ensure ensured enter entered entire entirely environment environments equal equally equipment error errors especially establish established estimate estimated evaluate evaluated evaluation event events eventually evidence exact exactly example examples exceed except exception exchange exclude excluded execute executed execution exist existing exists expand expanded expect expected experience experienced experiment experimental explain explained explaining explains explanation explicit explicitly explore export expose extend extended extension external extra extract extracted极
facility factor factors fail failed failing failure fair fairly false familiar feature featuresrials field fields figure file files final finally financial Fine finish finished firm fit fix fixed fixing follow followed following follows force forced form format formed former forms forth forward found foundation frame framework free freely frequency frequent frequently function functions fundamental furthermore future
`.trim().split(/\s+/);

const TIER3_DOMAIN_GENERIC_PROSE = `
generate generated generates generating generation generic global goal goals govern grade grant granted graph great ground guarantee guide guidelines
handle handled handles handling happen happened happens hard hardware harm head header health heavy help helped helpful helping helps hence hidden hide high highlight history hit hold holder holding holds honest host hosted hour hours huge human hundreds
idea ideal ideas identical identify identified identifies identifying identity ignore ignored illustrate image images immediate immediately impact implement implemented implementing implementation implementations imply import imported important impose improve improved improvement improvements include included includes including income increase increased increases increasing indeed independent independently index indicate indicated indicates indicating individual individuals industrial industry inevitable Influence inform information initial initially initialize initialized Initiative input inputs inquiry insert inside inspect inspection install installation installed instance instances instead instruction instructions instrument integer integrate integrated integration intended intense intention interact interaction interest internal international internet interpret interpretation interval intervention introduce introduced introduces introducing introduction invalid invest investigation involve involved involves involving issue issues item items iteration
join joined joint journal judge judgment jump justify justification
key keys keyword keywords knowledge
label labeled labels lack language languages large laser layer layers layout lead leader leading leads learn learned learning least leave leaves leaving lecture left legal length less level levels library libraries license lieu life lift light likewise limit limitation limitations limited limits line linear lines link linked links list listed listing lists listen literal literature live lives load loaded loading local locate located location locations lock log logged logging logic logical login long look looked looking looks loop loose loss lost lot lots low lower lowest luck
machine machines main mainly maintain maintained maintaining maintenance major majority makeakes manage managed management manager managing manifest manipulate manner manual manually many map mapped mapping maps margin mark marked marker market marriage mass master match matched matches matching material materials math mathematical matrix matter matters maximum maybe mean meaning means meant measure measured measurement measurements measures mechanism mechanisms media medical medium meet meeting meets member memory mention mentioned message messages metal method methodology methods middle might mile military million mind mine minimum FML minor minute minutes mirror miss missing mission mistake mix mixed mixture mode model modeled modeling models moderate modern modify modified modifying module modules moment monitor month months moral moreover morning mostly motion motor mount mouse move moved movement moves movie moving multiple multiply
name named names narrow nation national native natural naturally nature near nearby nearly neat necessary neck negative neither network networks neutral never nevertheless newly news nice night nine nobody noise nominal none nonetheless nor normal normally north notably note noted notes nothing notice noticed notion novel now nowhere nuclear number numerous
object objective objectives objects obligation observe observed observer observing obtain obtained obvious obviously occasion occasionally occupy occur occurred occurring occurs ocean odd odds offer offered offering offers office officer official officially often oil okay old omit omitted once ongoing online only onto open operate operated operating operation operational operations operator opinion opportunity oppose opposed opposite option optional options order ordinary organ organization organize organized orientation origin original originally outcome outcomes outer outline output outputs outside overall overcome overhead overlaperen
`.trim().split(/\s+/);

const TIER4_TRAILING_PROSE = `
pack package packages page pages pain paint pair panel paper papers paragraph parallel parameter parameters parent parents park part participant participate particular particularly partly partner party pass passed passes passing past path paths patient pattern patterns pause pay payment peace peak perform performance performed performing performs period permanent permission permit person personal personally personnel perspective phase phenomenon philosophy photo physical physically pick picture piece pieces pilot pin pipe pipeline place plain plan planned planning plans plant platform play player please pleasure plenty plot plug plus pocket poem point pole police policy politicalists poll pool poor popular population port portion portrait pose position positive possess possibility possible possibly post pot potential potentially pound pour power powerful practical practice precise precisely predict prediction prefer preference preferred prepare prepared preparing presence present preserve press pressure pretty prevent previous previously price pride primarily primary prime principal principle principles print printed prior priority private等奖 probable probably problem procedure procedures proceed process processed processes processing produce produced producer produces producing product production products profession professional profile profit program programmer programming programs progress project projects prominent promise promote prompt proof proper properly property proportion proposal propose proposed protect protection protein protocol proud prove proved provide provided provides providing province provision public publication publicly publish published pull pulse pump pure purpose pursue push put
qualify quality quantity quarter question questions quick quickly quiet quietly quit quite quote quoted
refine refined refinement refinements
race radio rail rain raise raised random range rank rapid rapidly rare rarely rate HCl rather ratio raw reach reached reaches react reaction read reader reading reads ready real realistic reality realize realized really reason reasonable reasons recall receive received ImGui recent recently recognize recognized recommend recommended record recorded recording records recover recovery red reduce reduced reduces reducing reduction refer reference referenced references referred referring refers reflect reflected reflection reform refuse regard regarding regardless regime region regional register regular regularly regulate reinforce reject rejected relate relatedipping relation relations relationship relative relatively release released relevant reliable relief rely remain remaining remains remark remember remind remote removal remove removed removing render repeat repeated replace replaced replacing reply report reported reporting reports represent representation representative represented represents reproduce request requested require required requirement requirements requires requiring research researcher resembleตั reserve reserved residentoph resolution resolve resolved resource resources respect respectively respond response responsibility responsible rest restore restrict result resulted resulting results retain retained retire return returned returning returns reveal revealed revenue reverse review reviewed revolution rewardhat
rich rideek right ring rise riskivers road rock role roles roll roof room root rope rough roughly round route routine row rows rule rulesiy run running runs rural rush
safe safely safety sakeighbor salary sale sales saltek same sample samples sanction sand satellite satisfyhip save saved saving scale scan scenario schedule scheme scholar school science scientific scientist scope score screen script sea search season seat second secret section sections sector secure security see seed seek seem segment select selected selection self sellikely send sending sends senior sense sensitive sentence sentences separate sequence series serious seriously serve served server servers service services session sessionsCh setoph setting settings settle seven several severefichiers shadow shake shall shape share shared shares sharing sharp sheet shelf shell shift shine ship shirt shock shoe shoot shop short shortly shot should shoulder shout show shownug shutek sick sideighbor sight sign signal signature significance significant significantly silence silent silver similar similarly simple simply simulate simulation simultaneouslyek sin sinceek singleink sir sister sit site sites situation six size sizes skill skills skin sky slave sleep slice slide slight slightly slip slow slowly small smart smell smile smoothek snap snow so-called soccer social society soft software soil solar soldier solid solution solutions solve solved solves solving someek somebody somehow someone something sometimes somewhat somewhere son song soon sophisticatedek sorry sort soul soundek soup source sources south spaceek spanek spare speak speaker special specialist species specific specifically specifyek spectrum speech speed spell spend spentek sphereek spin spirit spiritual splitek spokeek sponsor spot spread spring squareek stableek stack staff stageek stair stake stand standard standards standingek star stare start started starting starts state stated statement statements states static station статистик status stayek steady stealek steam steel step steps stickek still stir stock stomach stone stop stopped storage store stored stores storm storyek straight strain strangeek stranger strategic strategy stream street strength strengthen stress stretch strict strictly strikeek stringek strip stroke strong strongly structure structured structures struggle student students studio studyek stuff styleek subject subjects submit subsequent subsequentlyek substance substantialek substitute succeed success successful successfully such sudden suddenlyek suffer sufficientek sugar suggest suggested suggesting suggestion suggests suit suitable suiteek sum summary summer sunek super supply support supported supporting supports suppose supposedek sure surely surfaceek surgeryek surpriseek surroundek surveyek survival surviveek suspectek sustainek swear sweep sweetek swimek swing switch symboliek symptomiek systemiek systems
table tables tackle tail take tale talent talkek tall tank tap tape target task tasks taste taxek tea teach teacher teaching team tear technical technique techniques technologyek telephone television tell temperatureek temporary ten tend tendencyek tennis tension tent termek terms terribleek territory terror terrorismek test tested testing tests textek than thank thanks that the theater their them theme themselves then theoryek therapy there therefore these they thick thin thing things think thinking third thirty this those though thought thousand threat threaten three throat through throughout throwek thus ticket tie tight timeek times tiny tip tireek tired tissue titleek to today toe together tomorrow toneek tongue tonight too tool tools tooth top topic total totally touch tough tour tourist tournament toward towards tower townoy trace track trade tradition traditional traffic tragedy trail train trained training traitek transfer transform transformation transition translate translationek transportek trapek trash travelियाek treat treated treatmentek treaty treeek tremendous trend trialek tribe trickek trip troop troubleek truck true trulyek trustek truth tryek tubeek tunnel turnek twelve twenty twice twin two type types typical typically
uglyek ultimate ultimately unableek uncertainek uncleek under undergoek understand understandingek unfortunately uniformek union uniqueek unitiek united units universal universeek university unknown unlessek unlike unlikely until unusualek up upon upper urban urgeek us use used usefulek user users uses using usual usually utilityek utilize
vacationek valid valley valuableek value valuesek vanek variable variablesek variationek variety variousek vast vegetableek vehicle vehiclesek venture versionek versions versus very vessel veteran viaek victimek victory videoek view viewed viewer viewsek villageek violateek violenceek virtualekirtue virus visibleek vision visit visitor visualek vital voiceek volume voluntaryek voteek voter vulnerable
wageek wait waitingek wake walkek wallek wander wantek war warmek warn warningek wash wasteek watch water waveek way ways weak wealth weaponek wear weather web websiteek wedding weekek weekend weekly weigh weightek welcome welfare wellek west western wetek what whatever wheel when whenever where whereasek wherebyek wherever whether which while whisperek white who wholeek whom whose why wide widelyek wifen wild will willingek win windek windowek wineek wing winner winter wipeek wire wisdom wise wish with withdraw within without witness womanek women wonder wonderful woodek wooden wordek words work worked worker working works workshop worldek worried worry worth would wound wrapek write writer writingek written wrongek yard yeah year years yellow yes yesterday yet yieldek you youngek your yours yourselfek youth zone
`.trim().split(/\s+/).map(w => w.replace(/[^a-z-]/gi, '').toLowerCase()).filter(w => w.length >= 2);

const ALL_TIERS: Array<[string[], number, number]> = [
  [TIER1_FUNCTION_WORDS, 1, 0.98],
  [TIER2_PROSE_VERBS_MODIFIERS, 2, 0.90],
  [TIER3_DOMAIN_GENERIC_PROSE, 3, 0.80],
  [TIER4_TRAILING_PROSE, 3, 0.80],
];

export const COMMON_PROSE_MAP = new Map<string, { tier: number; stopWeight: number }>();
for (const [words, tier, weight] of ALL_TIERS) {
  for (const raw of words) {
    const clean = raw.replace(/[^a-z]/gi, '').toLowerCase();
    if (clean.length >= 2 && !COMMON_PROSE_MAP.has(clean)) {
      COMMON_PROSE_MAP.set(clean, { tier, stopWeight: weight });
      // Also add common regular inflections (-s, -es, -ed, -ing, -ly) so inflected prose words
      // like "provides", "factors", "mainly", "documents", "libraries" are covered O(1).
      if (clean.length >= 4) {
        for (const suffix of ['s', 'es', 'ed', 'ing', 'ly', 'ment', 'ments', 'tion', 'tions', 'ness', 'able', 'ible']) {
          const inflected = clean + suffix;
          if (!COMMON_PROSE_MAP.has(inflected)) {
            COMMON_PROSE_MAP.set(inflected, { tier, stopWeight: weight });
          }
        }
        if (clean.endsWith('y') && clean.length >= 5) {
          const ies = clean.slice(0, -1) + 'ies';
          if (!COMMON_PROSE_MAP.has(ies)) COMMON_PROSE_MAP.set(ies, { tier, stopWeight: weight });
        }
        if (clean.endsWith('e') && clean.length >= 5) {
          for (const sfx of ['d', 'r', 'rs', 'ing', 'ment', 'ments', 'tion', 'tions', 'able']) {
            const inf = clean.slice(0, -1) + sfx;
            if (!COMMON_PROSE_MAP.has(inf)) COMMON_PROSE_MAP.set(inf, { tier, stopWeight: weight });
          }
        }
      }
    }
  }
}

/**
 * Split any identifier (`ContrastiveEmbed`, `convert_ldm_vae_checkpoint`, `Http404`, `start_port`)
 * into lowercase atomic sub-tokens (`['contrastive', 'embed']`, `['convert', 'ldm', 'vae', 'checkpoint']`,
 * `['http', '404']`, `['start', 'port']`).
 */
export function splitIdentifierSubTokens(identifier: string): string[] {
  const camelExpanded = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d+)/g, '$1 $2')
    .replace(/(\d+)([a-zA-Z])/g, '$1 $2');
  const parts = camelExpanded.split(/[^a-zA-Z0-9]+/).map(p => p.toLowerCase()).filter(p => p.length >= 2);
  return [...new Set(parts)];
}

/**
 * Determine if a surface token has structural code/technical formatting
 * (`snake_case`, `camelCase`, `PascalCase` mid-sentence, digits, or dotted path)
 * versus a plain lowercase/TitleCase English prose word.
 */
export function hasTechnicalIdentifierFormatting(token: string): boolean {
  if (!token || token.length < 2) return false;
  if (/[_.\d/$]/.test(token)) return true;
  // CamelCase or ALLCAPS (length >= 2)
  if (/[a-z][A-Z]/.test(token) || /^[A-Z]{2,}[a-z0-9]*$/.test(token) || /^[A-Z][a-z0-9]+[A-Z]/.test(token)) {
    return true;
  }
  return false;
}

/**
 * Check if a token is common English prose according to the pre-populated lexicon
 * AND lacks technical identifier formatting (`snake_case`, `camelCase`, `ALL_CAPS`, digits).
 */
export function isCommonEnglishProseToken(token: string): boolean {
  if (hasTechnicalIdentifierFormatting(token)) return false;
  const low = token.toLowerCase();
  return COMMON_PROSE_MAP.has(low);
}

/**
 * Create and seed the SQLite `lexicon_priors` and `symbol_bm25_index` tables once on database open.
 * Uses `CREATE TABLE IF NOT EXISTS` outside `SCHEMA_V1` so the immutable v1 migration checksum is untouched.
 */
export function ensureLexiconAndSymbolTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lexicon_priors (
      term TEXT PRIMARY KEY,
      tier INTEGER NOT NULL,
      stop_weight REAL NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS symbol_bm25_index (
      namespace_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      symbol_lower TEXT NOT NULL,
      symbol_surface TEXT NOT NULL,
      role TEXT NOT NULL,
      role_weight REAL NOT NULL,
      PRIMARY KEY(namespace_id, source_id, symbol_lower, role)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS cf_symbol_bm25_lookup ON symbol_bm25_index(namespace_id, symbol_lower);
  `);

  const countRow = db.prepare('SELECT count(*) AS cnt FROM lexicon_priors').get() as { cnt?: number } | undefined;
  if (!countRow || Number(countRow.cnt ?? 0) === 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const insert = db.prepare('INSERT OR IGNORE INTO lexicon_priors(term, tier, stop_weight) VALUES(?, ?, ?)');
      for (const [term, info] of COMMON_PROSE_MAP.entries()) {
        insert.run(term, info.tier, info.stopWeight);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
