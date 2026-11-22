const TYPES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
const IMAGE_TAGS = new Map([
  [0x0100, 'Largeur image'],
  [0x0101, 'Hauteur image'],
  [0x010F, 'Fabricant'],
  [0x0110, 'Modèle'],
  [0x0112, 'Orientation'],
  [0x0132, 'Date de modification'],
  [0x013B, 'Auteur'],
  [0x8298, 'Droits d’auteur'],
]);
const PHOTO_TAGS = new Map([
  [0x829A, 'Temps d’exposition'],
  [0x829D, 'Ouverture'],
  [0x8827, 'Sensibilité ISO'],
  [0x9003, 'Date de prise de vue'],
  [0x9004, 'Date de numérisation'],
  [0x9201, 'Vitesse d’obturation'],
  [0x9202, 'Valeur d’ouverture'],
  [0x9204, 'Correction d’exposition'],
  [0x9209, 'Flash'],
  [0x920A, 'Distance focale'],
  [0xA002, 'Largeur en pixels'],
  [0xA003, 'Hauteur en pixels'],
  [0xA434, 'Objectif'],
]);

const numberOrArray = (values) => values.length === 1 ? values[0] : values;

function readTiff(view, tiffStart, tiffEnd) {
  if (tiffStart + 8 > tiffEnd) throw new Error('En-tête TIFF EXIF incomplet.');
  const byteOrder = String.fromCharCode(view.getUint8(tiffStart), view.getUint8(tiffStart + 1));
  if (byteOrder !== 'II' && byteOrder !== 'MM') throw new Error('Ordre des octets TIFF invalide.');
  const littleEndian = byteOrder === 'II';
  const checkedOffset = (offset, length = 1) => {
    if (!Number.isSafeInteger(offset) || offset < tiffStart || offset + length > tiffEnd) {
      throw new Error('Le bloc EXIF contient un décalage hors limites.');
    }
  };
  const u16 = (offset) => {
    checkedOffset(offset, 2);
    return view.getUint16(offset, littleEndian);
  };
  const u32 = (offset) => {
    checkedOffset(offset, 4);
    return view.getUint32(offset, littleEndian);
  };
  if (u16(tiffStart + 2) !== 42) throw new Error('Signature TIFF EXIF invalide.');

  function readIfd(relativeOffset) {
    if (!relativeOffset) return new Map();
    const start = tiffStart + relativeOffset;
    const count = u16(start);
    if (count > 4096) throw new Error('Le répertoire EXIF contient trop d’entrées.');
    checkedOffset(start + 2, count * 12 + 4);
    const entries = new Map();
    let totalValues = 0;
    for (let index = 0; index < count; index += 1) {
      const entryOffset = start + 2 + index * 12;
      const tag = u16(entryOffset);
      const type = u16(entryOffset + 2);
      const valueCount = u32(entryOffset + 4);
      const typeSize = TYPES[type];
      if (!typeSize) continue;
      totalValues += valueCount;
      if (valueCount > 4096 || totalValues > 20000) throw new Error('Le bloc EXIF contient des valeurs trop volumineuses.');
      const byteLength = typeSize * valueCount;
      const dataOffset = byteLength <= 4 ? entryOffset + 8 : tiffStart + u32(entryOffset + 8);
      checkedOffset(dataOffset, byteLength);
      const values = [];
      for (let item = 0; item < valueCount; item += 1) {
        const offset = dataOffset + item * typeSize;
        if (type === 2) values.push(view.getUint8(offset));
        else if (type === 1 || type === 7) values.push(view.getUint8(offset));
        else if (type === 3) values.push(u16(offset));
        else if (type === 4) values.push(u32(offset));
        else if (type === 5) {
          const denominator = u32(offset + 4);
          values.push(denominator ? u32(offset) / denominator : null);
        } else if (type === 9) values.push(view.getInt32(offset, littleEndian));
        else if (type === 10) {
          const denominator = view.getInt32(offset + 4, littleEndian);
          values.push(denominator ? view.getInt32(offset, littleEndian) / denominator : null);
        }
      }
      if (type === 2) {
        entries.set(tag, values.map((byte) => String.fromCharCode(byte)).join('').replace(/\0+$/, '').trim());
      } else {
        entries.set(tag, numberOrArray(values));
      }
    }
    return entries;
  }

  const firstIfd = readIfd(u32(tiffStart + 4));
  const exifIfd = readIfd(firstIfd.get(0x8769));
  const gpsIfd = readIfd(firstIfd.get(0x8825));
  return { firstIfd, exifIfd, gpsIfd };
}

function decimalCoordinate(value, reference) {
  if (!Array.isArray(value) || value.length < 3 || !value.every(Number.isFinite)) return null;
  const decimal = value[0] + value[1] / 60 + value[2] / 3600;
  return reference === 'S' || reference === 'W' ? -decimal : decimal;
}

function formatValue(value, tag) {
  if (tag === 0x0112 && typeof value === 'number') {
    return ({ 1: 'Normale', 2: 'Miroir horizontal', 3: 'Rotation 180°', 4: 'Miroir vertical', 6: 'Rotation 90° horaire', 8: 'Rotation 90° antihoraire' })[value] ?? String(value);
  }
  if (tag === 0x829A && typeof value === 'number') return value > 0 && value < 1 ? `1/${Math.round(1 / value)} s` : `${value} s`;
  if (tag === 0x829D && typeof value === 'number') return `f/${value.toLocaleString('fr-FR', { maximumFractionDigits: 2 })}`;
  if (tag === 0x920A && typeof value === 'number') return `${value.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} mm`;
  if (tag === 0x9209 && typeof value === 'number') return value === 0 ? 'Désactivé' : `Code ${value}`;
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

export function readJpegExif(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0, false) !== 0xFFD8) throw new Error('Le fichier ne semble pas être une image JPEG.');
  let offset = 2;
  let directories = null;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xFF) { offset += 1; continue; }
    while (offset < view.byteLength && view.getUint8(offset) === 0xFF) offset += 1;
    const marker = view.getUint8(offset);
    offset += 1;
    if (marker === 0xD9 || marker === 0xDA) break;
    if (marker >= 0xD0 && marker <= 0xD7 || marker === 0x01) continue;
    if (offset + 2 > view.byteLength) break;
    const segmentLength = view.getUint16(offset, false);
    if (segmentLength < 2 || offset + segmentLength > view.byteLength) throw new Error('Segment JPEG tronqué ou invalide.');
    const dataStart = offset + 2;
    if (marker === 0xE1 && segmentLength >= 8
      && view.getUint8(dataStart) === 0x45
      && view.getUint8(dataStart + 1) === 0x78
      && view.getUint8(dataStart + 2) === 0x69
      && view.getUint8(dataStart + 3) === 0x66
      && view.getUint8(dataStart + 4) === 0
      && view.getUint8(dataStart + 5) === 0) {
      directories = readTiff(view, dataStart + 6, offset + segmentLength);
      break;
    }
    offset += segmentLength;
  }
  if (!directories) throw new Error('Aucune métadonnée EXIF trouvée dans cette image.');

  const metadata = [];
  for (const [tag, label] of IMAGE_TAGS) {
    if (directories.firstIfd.has(tag)) metadata.push({ group: 'Image', label, value: formatValue(directories.firstIfd.get(tag), tag) });
  }
  for (const [tag, label] of PHOTO_TAGS) {
    if (directories.exifIfd.has(tag)) metadata.push({ group: 'Photo', label, value: formatValue(directories.exifIfd.get(tag), tag) });
  }
  const gps = directories.gpsIfd;
  const latitude = decimalCoordinate(gps.get(2), gps.get(1));
  const longitude = decimalCoordinate(gps.get(4), gps.get(3));
  const altitude = gps.has(6) ? gps.get(6) * (gps.get(5) === 1 ? -1 : 1) : null;
  const location = latitude === null || longitude === null
    ? null
    : { latitude: Number(latitude.toFixed(6)), longitude: Number(longitude.toFixed(6)), altitude: altitude === null ? null : Number(altitude.toFixed(2)) };
  return { metadata, location };
}
