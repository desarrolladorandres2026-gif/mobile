import { describe, it, expect } from 'vitest';
import {
  INITIAL_CROP, SQUARE, clampCrop, cropSourcePixels, rotateCrop, type CropResult,
} from './cropGeometry';

const photo = (naturalWidth: number, naturalHeight: number, transform = INITIAL_CROP): CropResult => ({
  naturalWidth, naturalHeight, transform, width: 1200, height: 1200,
});

describe('cropSourcePixels', () => {
  it('sin zoom, el lado corto de la original', () => {
    expect(cropSourcePixels(photo(4000, 3000))).toBe(3000);
  });

  it('el zoom reduce los píxeles útiles en la misma proporción', () => {
    expect(cropSourcePixels(photo(4000, 3000, { ...INITIAL_CROP, zoom: 2 }))).toBe(1500);
  });

  it('girar una foto cuadrada no cambia nada', () => {
    expect(cropSourcePixels(photo(800, 600, { ...INITIAL_CROP, rotation: 90 }))).toBe(600);
  });
});

describe('rotateCrop', () => {
  it('suma 90° y da la vuelta completa', () => {
    let transform = INITIAL_CROP;
    for (const expected of [90, 180, 270, 0]) {
      transform = rotateCrop(transform);
      expect(transform.rotation).toBe(expected);
    }
  });

  it('lleva el encuadre (x, y) a (−y, x): lo que estaba a la derecha queda abajo', () => {
    expect(rotateCrop({ zoom: 2, rotation: 0, x: 0.2, y: 0 })).toEqual({ zoom: 2, rotation: 90, x: 0, y: 0.2 });
    expect(rotateCrop({ zoom: 2, rotation: 0, x: 0, y: 0.1 })).toEqual({ zoom: 2, rotation: 90, x: -0.1, y: 0 });
  });

  it('en un marco cuadrado el encuadre girado sigue dentro de los márgenes', () => {
    const image = { naturalWidth: 1600, naturalHeight: 1000 };
    const transform = { zoom: 1.5, rotation: 0, ...clampCrop({ x: 1, y: 1 }, image, 0, 1.5, SQUARE) };
    const rotated = rotateCrop(transform);
    expect(clampCrop(rotated, image, rotated.rotation, rotated.zoom, SQUARE)).toEqual({ x: rotated.x, y: rotated.y });
  });
});

describe('clampCrop', () => {
  it('a zoom 1 una foto cuadrada no se puede mover', () => {
    expect(clampCrop({ x: 0.3, y: -0.3 }, { naturalWidth: 1000, naturalHeight: 1000 }, 0, 1, SQUARE))
      .toEqual({ x: 0, y: 0 });
  });

  it('una apaisada solo se desplaza a lo ancho, hasta la mitad de lo que sobra', () => {
    // 2000×1000 cubriendo un cuadrado: la foto mide 2 marcos de ancho y
    // sobra uno, medio por cada lado.
    expect(clampCrop({ x: 5, y: 5 }, { naturalWidth: 2000, naturalHeight: 1000 }, 0, 1, SQUARE))
      .toEqual({ x: 0.5, y: 0 });
  });
});
