/**
 * Qué logo le corresponde a cada entidad de la lista de PSE.
 *
 * Wompi manda solo código y nombre, y el nombre llega como lo registró cada
 * entidad ("BANCO DAVIVIENDA", "BANCO ITAU", "UALÁ"…). Por eso se busca por
 * palabras del nombre y no por código: los códigos cambian entre el sandbox y
 * producción, los nombres no.
 *
 * Lo que no tiene logo propio (Bancamía, GNB Sudameris, Banco Unión,
 * Serfinanza, Coopcentral, Bold, dale!…) cae en el de PSE.
 */

export type BankLogoKey =
  | 'nequi' | 'pse'
  | 'accion' | 'agrario' | 'alianza' | 'avvillas' | 'ban100' | 'bancolombia'
  | 'bancoomeva' | 'bbva' | 'bogota' | 'cajasocial' | 'cfa' | 'citibank' | 'coink'
  | 'coltefinanciera' | 'confiar' | 'contactar' | 'cotrafa' | 'crezcamos'
  | 'davibank' | 'daviplata' | 'davivienda' | 'ding' | 'falabella' | 'finandina'
  | 'global66' | 'iris' | 'itau' | 'jfk' | 'jpmorgan' | 'juriscoop' | 'lulo'
  | 'movii' | 'mundomujer' | 'nu' | 'occidente' | 'paycash' | 'pichincha'
  | 'popular' | 'powwi' | 'rappipay' | 'santander' | 'uala';

/** Sin tildes y en mayúsculas, para comparar sin importar cómo lo escribió el banco. */
export function normalizeBankName(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

// Palabras completas donde el nombre es corto ("NU", "DING", "IRIS", "JFK"),
// para no pescar "BANCO UNION" ni "NUEVO". Scotiabank Colpatria pasó a
// llamarse DAVIbank: si Wompi aún manda el nombre viejo, sale el nuevo logo.
const RULES: [RegExp, BankLogoKey][] = [
  [/\bNEQUI\b/, 'nequi'],
  [/DAVIPLATA/, 'daviplata'],
  [/DAVIBANK|SCOTIABANK|COLPATRIA/, 'davibank'],
  [/DAVIVIENDA/, 'davivienda'],
  [/BANCOLOMBIA/, 'bancolombia'],
  [/\bBBVA\b/, 'bbva'],
  [/\bBOGOTA\b/, 'bogota'],
  [/OCCIDENTE/, 'occidente'],
  [/\bPOPULAR\b/, 'popular'],
  [/AV ?VILLAS/, 'avvillas'],
  [/CAJA SOCIAL/, 'cajasocial'],
  [/AGRARIO/, 'agrario'],
  [/\bITAU\b/, 'itau'],
  [/\bNU\b|NUBANK/, 'nu'],
  [/FALABELLA/, 'falabella'],
  [/PICHINCHA/, 'pichincha'],
  [/ACCION FIDUCIARIA/, 'accion'],
  [/ALIANZA FIDUCIARIA/, 'alianza'],
  [/\bBAN ?100\b/, 'ban100'],
  [/COOMEVA/, 'bancoomeva'],
  [/\bCFA\b/, 'cfa'],
  [/\bCITI(BANK)?\b/, 'citibank'],
  [/\bCOINK\b/, 'coink'],
  [/COLTEFINANCIERA/, 'coltefinanciera'],
  [/\bCONFIAR\b/, 'confiar'],
  [/CONTACTAR/, 'contactar'],
  [/COTRAFA/, 'cotrafa'],
  [/CREZCAMOS/, 'crezcamos'],
  [/\bDING\b/, 'ding'],
  [/FINANDINA/, 'finandina'],
  [/GLOBAL ?66/, 'global66'],
  [/\bIRIS\b/, 'iris'],
  [/\bJFK\b/, 'jfk'],
  [/J\.? ?P\.? ?MORGAN/, 'jpmorgan'],
  [/JURISCOOP/, 'juriscoop'],
  [/\bLULO\b/, 'lulo'],
  [/\bMOVII\b/, 'movii'],
  [/MUNDO MUJER/, 'mundomujer'],
  [/PAYCASH/, 'paycash'],
  [/\bPOWWI\b/, 'powwi'],
  [/RAPPI ?PAY/, 'rappipay'],
  [/SANTANDER/, 'santander'],
  [/\bUALA\b/, 'uala'],
];

export function bankLogoKey(name: string): BankLogoKey {
  const normalized = normalizeBankName(name);
  return RULES.find(([pattern]) => pattern.test(normalized))?.[1] ?? 'pse';
}
