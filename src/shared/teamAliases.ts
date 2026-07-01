const explicitAliases: Record<string, string> = {
  "allemagne": "germany",
  "angleterre": "england",
  "arabie saoudite": "saudi arabia",
  "argentine": "argentina",
  "algeria": "algeria",
  "algerie": "algeria",
  "algérie": "algeria",
  "australie": "australia",
  "autriche": "austria",
  "bosnia herzegovina": "bosnia and herzegovina",
  "bosnia and herzegovina": "bosnia and herzegovina",
  "bosnie": "bosnia and herzegovina",
  "bosnie herzégovine": "bosnia and herzegovina",
  "bosnie herzegovine": "bosnia and herzegovina",
  "belgique": "belgium",
  "bresil": "brazil",
  "bresil.": "brazil",
  "cabo verde": "cape verde",
  "canada": "canada",
  "cap vert": "cape verde",
  "cap-vert": "cape verde",
  "colombie": "colombia",
  "coree du sud": "south korea",
  "cote d ivoire": "cote d'ivoire",
  "cote d'ivoire": "cote d'ivoire",
  "côte d ivoire": "cote d'ivoire",
  "côte d'ivoire": "cote d'ivoire",
  "croatie": "croatia",
  "curacao": "curacao",
  "curaçao": "curacao",
  "danemark": "denmark",
  "egypte": "egypt",
  "égypte": "egypt",
  "equateur": "ecuador",
  "équateur": "ecuador",
  "espagne": "spain",
  "etats unis": "united states",
  "états unis": "united states",
  "états-unis": "united states",
  "france": "france",
  "ghana": "ghana",
  "irak": "iraq",
  "iran": "iran",
  "japon": "japan",
  "jordanie": "jordan",
  "maroc": "morocco",
  "mexique": "mexico",
  "norvege": "norway",
  "norvège": "norway",
  "nouvelle zelande": "new zealand",
  "nouvelle-zélande": "new zealand",
  "nouvelle zélande": "new zealand",
  "ouzbekistan": "uzbekistan",
  "ouzbekistan.": "uzbekistan",
  "ouzbékistan": "uzbekistan",
  "panama": "panama",
  "paraguay": "paraguay",
  "pays bas": "netherlands",
  "pays-bas": "netherlands",
  "portugal": "portugal",
  "qatar": "qatar",
  "rd congo": "dr congo",
  "république démocratique du congo": "dr congo",
  "senegal": "senegal",
  "sénégal": "senegal",
  "suede": "sweden",
  "suède": "sweden",
  "suisse": "switzerland",
  "tunisie": "tunisia",
  "turkiye": "turkiye",
  "turquie": "turkiye",
  "uruguay": "uruguay"
};

export function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export function teamKey(team: string): string {
  const key = stripDiacritics(team)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return explicitAliases[key] ?? key;
}

export function slugify(value: string): string {
  return teamKey(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function teamsMatch(a: string, b: string): boolean {
  return teamKey(a) === teamKey(b);
}

export function matchSimilarity(a: string, b: string): number {
  const ak = teamKey(a);
  const bk = teamKey(b);
  if (ak === bk) return 1;
  const aParts = new Set(ak.split(" "));
  const bParts = new Set(bk.split(" "));
  const overlap = [...aParts].filter((p) => bParts.has(p)).length;
  return overlap / Math.max(aParts.size, bParts.size, 1);
}
