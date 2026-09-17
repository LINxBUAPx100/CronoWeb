/**
 * Catálogo de materias comunes en México, por nivel educativo.
 *
 * Existe para que capturar una escuela empiece en un minuto y no en veinte:
 * once materias escritas a mano, con su abreviatura y su color, es exactamente
 * el trabajo aburrido que hace que alguien abandone la herramienta antes de ver
 * el primer horario.
 *
 * Los nombres siguen los planes vigentes de la SEP —los campos formativos en
 * preescolar, las asignaturas de primaria y secundaria, el tronco común del
 * bachillerato general— pero NO pretenden ser el plan oficial de nadie: son un
 * punto de partida editable. Cada escuela borra lo que no lleva, agrega lo suyo
 * y ajusta las horas, que es donde de verdad se diferencian entre sí.
 *
 * Cada entrada es `[nombre, abreviatura, ¿conviene temprano?]`. La tercera
 * columna marca las materias que piden cabeza fresca: el motor intentará
 * colocarlas en los primeros bloques del día.
 *
 * @module model/catalog
 */

/** @type {Record<string, Array<[string, string, boolean]>>} */
export const SUBJECT_CATALOG = {
  // Preescolar: campos formativos, no asignaturas. Se nombran como los usa la
  // educadora al armar su jornada.
  kinder: [
    ['Lenguaje y Comunicación', 'Leng', true],
    ['Pensamiento Matemático', 'Mat', true],
    ['Exploración del Mundo Natural', 'Expl', true],
    ['Educación Socioemocional', 'Socio', false],
    ['Artes', 'Art', false],
    ['Educación Física', 'EdFís', false],
    ['Inglés', 'Ing', false],
  ],

  primaria: [
    ['Español', 'Esp', true],
    ['Matemáticas', 'Mat', true],
    ['Ciencias Naturales', 'CNat', true],
    ['Conocimiento del Medio', 'CMed', true],
    ['Historia', 'His', false],
    ['Geografía', 'Geo', false],
    ['Formación Cívica y Ética', 'FCyE', false],
    ['Educación Socioemocional', 'Socio', false],
    ['Vida Saludable', 'Vida', false],
    ['Artes', 'Art', false],
    ['Educación Física', 'EdFís', false],
    ['Inglés', 'Ing', false],
  ],

  secundaria: [
    ['Español', 'Esp', true],
    ['Matemáticas', 'Mat', true],
    ['Biología', 'Bio', true],
    ['Física', 'Fís', true],
    ['Química', 'Quím', true],
    ['Historia', 'His', false],
    ['Geografía', 'Geo', false],
    ['Formación Cívica y Ética', 'FCyE', false],
    ['Inglés', 'Ing', false],
    ['Tecnología', 'Tec', false],
    ['Artes', 'Art', false],
    ['Educación Física', 'EdFís', false],
    ['Tutoría', 'Tut', false],
  ],

  // Bachillerato general: tronco común. Las materias de la carrera técnica o del
  // área propedéutica se agregan a mano y se marcan como especialidad.
  preparatoria: [
    ['Matemáticas', 'Mat', true],
    ['Taller de Lectura y Redacción', 'TLR', true],
    ['Química', 'Quím', true],
    ['Física', 'Fís', true],
    ['Biología', 'Bio', true],
    ['Historia de México', 'HMéx', false],
    ['Historia Universal', 'HUni', false],
    ['Geografía', 'Geo', false],
    ['Introducción a las Ciencias Sociales', 'ICS', false],
    ['Ética y Valores', 'Ética', false],
    ['Filosofía', 'Filo', false],
    ['Informática', 'Info', false],
    ['Metodología de la Investigación', 'MetIn', false],
    ['Inglés', 'Ing', false],
    ['Orientación Educativa', 'Orient', false],
    ['Educación Física', 'EdFís', false],
    ['Actividades Artísticas', 'Art', false],
  ],
};
