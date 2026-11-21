/**
 * Guatemala's 22 departamentos and 340 municipios — the canonical list used
 * to validate an address on the server and to fill the order form's lists.
 *
 * Source: the official political division (INE / Código Municipal), as of
 * 2026-11-16; the newest municipios included are Petatán (Huehuetenango),
 * Sipacate (Escuintla), San José La Máquina (Suchitepéquez), La Blanca (San
 * Marcos), El Chal and Las Cruces (Petén) and Raxruhá (Alta Verapaz).
 *
 * A valid place is not a covered place: commercial coverage is
 * `shopify_config.shipping_coverage` (coverageVerdict), and whether the
 * carrier accepts the locality is only known when the supplier takes the order.
 *
 * public/shopify-order-form.js carries the same table (a static script cannot
 * import this file); gt-geo.test.ts fails if the two drift apart.
 */
export const GT_MUNICIPIOS: Record<string, readonly string[]> = {
  'Alta Verapaz': ['Cahabón', 'Chahal', 'Chisec', 'Cobán', 'Fray Bartolomé de las Casas', 'Lanquín', 'Panzós', 'Raxruhá', 'San Cristóbal Verapaz', 'San Juan Chamelco', 'San Pedro Carchá', 'Santa Catalina La Tinta', 'Santa Cruz Verapaz', 'Senahú', 'Tactic', 'Tamahú', 'Tucurú'],
  'Baja Verapaz': ['Cubulco', 'El Chol', 'Granados', 'Purulhá', 'Rabinal', 'Salamá', 'San Jerónimo', 'San Miguel Chicaj'],
  'Chimaltenango': ['Acatenango', 'Chimaltenango', 'Comalapa', 'El Tejar', 'Parramos', 'Patzicía', 'Patzún', 'Pochuta', 'San Andrés Itzapa', 'San José Poaquil', 'San Martín Jilotepeque', 'Santa Apolonia', 'Santa Cruz Balanyá', 'Tecpán Guatemala', 'Yepocapa', 'Zaragoza'],
  'Chiquimula': ['Camotán', 'Chiquimula', 'Concepción Las Minas', 'Esquipulas', 'Ipala', 'Jocotán', 'Olopa', 'Quezaltepeque', 'San Jacinto', 'San José La Arada', 'San Juan Ermita'],
  'El Progreso': ['El Jícaro', 'Guastatoya', 'Morazán', 'San Agustín Acasaguastlán', 'San Antonio La Paz', 'San Cristóbal Acasaguastlán', 'Sanarate', 'Sansare'],
  'Escuintla': ['Escuintla', 'Guanagazapa', 'Iztapa', 'La Democracia', 'La Gomera', 'Masagua', 'Nueva Concepción', 'Palín', 'San José', 'San Vicente Pacaya', 'Santa Lucía Cotzumalguapa', 'Sipacate', 'Siquinalá', 'Tiquisate'],
  'Guatemala': ['Amatitlán', 'Chinautla', 'Chuarrancho', 'Fraijanes', 'Guatemala', 'Mixco', 'Palencia', 'San José del Golfo', 'San José Pinula', 'San Juan Sacatepéquez', 'San Miguel Petapa', 'San Pedro Ayampuc', 'San Pedro Sacatepéquez', 'San Raymundo', 'Santa Catarina Pinula', 'Villa Canales', 'Villa Nueva'],
  'Huehuetenango': ['Aguacatán', 'Barillas', 'Chiantla', 'Colotenango', 'Concepción Huista', 'Cuilco', 'Huehuetenango', 'Ixtahuacán', 'Jacaltenango', 'La Democracia', 'La Libertad', 'Malacatancito', 'Nentón', 'Petatán', 'San Antonio Huista', 'San Gaspar Ixchil', 'San Juan Atitán', 'San Juan Ixcoy', 'San Mateo Ixtatán', 'San Miguel Acatán', 'San Pedro Necta', 'San Rafael La Independencia', 'San Rafael Petzal', 'San Sebastián Coatán', 'San Sebastián Huehuetenango', 'Santa Ana Huista', 'Santa Bárbara', 'Santa Eulalia', 'Santiago Chimaltenango', 'Soloma', 'Tectitán', 'Todos Santos Cuchumatán', 'Unión Cantinil'],
  'Izabal': ['El Estor', 'Livingston', 'Los Amates', 'Morales', 'Puerto Barrios'],
  'Jalapa': ['Jalapa', 'Mataquescuintla', 'Monjas', 'San Carlos Alzatate', 'San Luis Jilotepeque', 'San Manuel Chaparrón', 'San Pedro Pinula'],
  'Jutiapa': ['Agua Blanca', 'Asunción Mita', 'Atescatempa', 'Comapa', 'Conguaco', 'El Adelanto', 'El Progreso', 'Jalpatagua', 'Jerez', 'Jutiapa', 'Moyuta', 'Pasaco', 'Quesada', 'San José Acatempa', 'Santa Catarina Mita', 'Yupiltepeque', 'Zapotitlán'],
  'Petén': ['Dolores', 'El Chal', 'Flores', 'La Libertad', 'Las Cruces', 'Melchor de Mencos', 'Poptún', 'San Andrés', 'San Benito', 'San Francisco', 'San José', 'San Luis', 'Santa Ana', 'Sayaxché'],
  'Quetzaltenango': ['Almolonga', 'Cabricán', 'Cajolá', 'Cantel', 'Coatepeque', 'Colomba', 'Concepción Chiquirichapa', 'El Palmar', 'Flores Costa Cuca', 'Génova', 'Huitán', 'La Esperanza', 'Olintepeque', 'Ostuncalco', 'Palestina de Los Altos', 'Quetzaltenango', 'Salcajá', 'San Carlos Sija', 'San Francisco La Unión', 'San Martín Sacatepéquez', 'San Mateo', 'San Miguel Sigüilá', 'Sibilia', 'Zunil'],
  'Quiché': ['Canillá', 'Chajul', 'Chicamán', 'Chiché', 'Chichicastenango', 'Chinique', 'Cunén', 'Ixcán', 'Joyabaj', 'Nebaj', 'Pachalum', 'Patzité', 'Sacapulas', 'San Andrés Sajcabajá', 'San Antonio Ilotenango', 'San Bartolomé Jocotenango', 'San Juan Cotzal', 'San Pedro Jocopilas', 'Santa Cruz del Quiché', 'Uspantán', 'Zacualpa'],
  'Retalhuleu': ['Champerico', 'El Asintal', 'Nuevo San Carlos', 'Retalhuleu', 'San Andrés Villa Seca', 'San Felipe', 'San Martín Zapotitlán', 'San Sebastián', 'Santa Cruz Muluá'],
  'Sacatepéquez': ['Alotenango', 'Antigua Guatemala', 'Ciudad Vieja', 'Jocotenango', 'Magdalena Milpas Altas', 'Pastores', 'San Antonio Aguas Calientes', 'San Bartolomé Milpas Altas', 'San Lucas Sacatepéquez', 'San Miguel Dueñas', 'Santa Catarina Barahona', 'Santa Lucía Milpas Altas', 'Santa María de Jesús', 'Santiago Sacatepéquez', 'Santo Domingo Xenacoj', 'Sumpango'],
  'San Marcos': ['Ayutla', 'Catarina', 'Comitancillo', 'Concepción Tutuapa', 'El Quetzal', 'El Rodeo', 'El Tumbador', 'Esquipulas Palo Gordo', 'Ixchiguán', 'La Blanca', 'La Reforma', 'Malacatán', 'Nuevo Progreso', 'Ocós', 'Pajapita', 'Río Blanco', 'San Antonio Sacatepéquez', 'San Cristóbal Cucho', 'San José Ojetenam', 'San Lorenzo', 'San Marcos', 'San Miguel Ixtahuacán', 'San Pablo', 'San Pedro Sacatepéquez', 'San Rafael Pie de la Cuesta', 'Sibinal', 'Sipacapa', 'Tacaná', 'Tajumulco', 'Tejutla'],
  'Santa Rosa': ['Barberena', 'Casillas', 'Chiquimulilla', 'Cuilapa', 'Guazacapán', 'Nueva Santa Rosa', 'Oratorio', 'Pueblo Nuevo Viñas', 'San Juan Tecuaco', 'San Rafael Las Flores', 'Santa Cruz Naranjo', 'Santa María Ixhuatán', 'Santa Rosa de Lima', 'Taxisco'],
  'Sololá': ['Concepción', 'Nahualá', 'Panajachel', 'San Andrés Semetabaj', 'San Antonio Palopó', 'San José Chacayá', 'San Juan La Laguna', 'San Lucas Tolimán', 'San Marcos La Laguna', 'San Pablo La Laguna', 'San Pedro La Laguna', 'Santa Catarina Ixtahuacán', 'Santa Catarina Palopó', 'Santa Clara La Laguna', 'Santa Cruz La Laguna', 'Santa Lucía Utatlán', 'Santa María Visitación', 'Santiago Atitlán', 'Sololá'],
  'Suchitepéquez': ['Chicacao', 'Cuyotenango', 'Mazatenango', 'Patulul', 'Pueblo Nuevo', 'Río Bravo', 'Samayac', 'San Antonio Suchitepéquez', 'San Bernardino', 'San Francisco Zapotitlán', 'San Gabriel', 'San José El Ídolo', 'San José La Máquina', 'San Juan Bautista', 'San Lorenzo', 'San Miguel Panán', 'San Pablo Jocopilas', 'Santa Bárbara', 'Santo Domingo Suchitepéquez', 'Santo Tomás La Unión', 'Zunilito'],
  'Totonicapán': ['Momostenango', 'San Andrés Xecul', 'San Bartolo', 'San Cristóbal Totonicapán', 'San Francisco El Alto', 'Santa Lucía La Reforma', 'Santa María Chiquimula', 'Totonicapán'],
  'Zacapa': ['Cabañas', 'Estanzuela', 'Gualán', 'Huité', 'La Unión', 'Río Hondo', 'San Diego', 'San Jorge', 'Teculután', 'Usumatlán', 'Zacapa'],
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase()

/** How people write the capital and Petapa; nothing else is guessed. */
const ALIASES: Record<string, string> = {
  'ciudad de guatemala': 'Guatemala', 'guatemala ciudad': 'Guatemala', capital: 'Guatemala', 'ciudad capital': 'Guatemala',
  petapa: 'San Miguel Petapa',
}

const BY_FOLDED = new Map(Object.entries(GT_MUNICIPIOS).map(([departamento, municipios]) =>
  [fold(departamento), { departamento, municipios: new Map(municipios.map((m) => [fold(m), m])) }]))

export type MunicipioCheck =
  | { ok: true; municipio: string; departamento: string }
  /** `departamentos`: where a municipio of that name does exist (empty = no such municipio). */
  | { ok: false; departamentos: string[] }

/** Pure: the canonical municipio inside that departamento. Accents, case and
 *  spacing are normalised; a place is never guessed. A name that exists in
 *  another departamento (homonyms: San Pedro Sacatepéquez, La Libertad, San
 *  José…) is refused with the departamentos it does belong to, so the caller
 *  can ask instead of assuming. */
export function checkMunicipio(municipio: string, departamento: string): MunicipioCheck {
  const key = fold(ALIASES[fold(municipio)] ?? municipio)
  const dep = BY_FOLDED.get(fold(departamento) === 'el quiche' ? 'quiche' : fold(departamento))
  const found = dep?.municipios.get(key)
  if (dep && found) return { ok: true, municipio: found, departamento: dep.departamento }
  return { ok: false, departamentos: [...BY_FOLDED.values()].filter((d) => d.municipios.has(key)).map((d) => d.departamento) }
}

/** Pure: the departamentos that have a municipio with this name. */
export function departamentosOfMunicipio(municipio: string): string[] {
  const key = fold(ALIASES[fold(municipio)] ?? municipio)
  return [...BY_FOLDED.values()].filter((d) => d.municipios.has(key)).map((d) => d.departamento)
}
