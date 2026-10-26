import {BRAND_DEFAULTS, BUTTON_DEFAULTS} from '@plunk/shared';
import {beforeEach, describe, expect, it} from 'vitest';

import {BrandService} from '../BrandService';
import {factories, getPrismaClient} from '../../../../../test/helpers';

describe('BrandService', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  it('gives a project without a brand the look emails always had', async () => {
    expect(await BrandService.get(projectId)).toEqual({...BRAND_DEFAULTS, button: BUTTON_DEFAULTS});
  });

  it('saves a brand and reads it back, replacing the previous one', async () => {
    await BrandService.save(projectId, {textColor: '#111111'});
    const saved = await BrandService.save(projectId, {
      font: 'book-serif',
      backgroundColor: '#F3F4F6',
      contentWidth: 600,
      button: {shape: 'pill'},
    });

    expect(saved).toEqual({
      ...BRAND_DEFAULTS,
      font: 'book-serif',
      backgroundColor: '#f3f4f6',
      contentWidth: 600,
      button: {...BUTTON_DEFAULTS, shape: 'pill'},
    });
    expect(await BrandService.get(projectId)).toEqual(saved);
    expect(await prisma.plunkLiteProjectBrand.count({where: {projectId}})).toBe(1);
  });

  it('only stores known values', async () => {
    await BrandService.save(projectId, {textColor: 'red; x', font: 'comic-sans', evil: '<script>'});

    const row = await prisma.plunkLiteProjectBrand.findUniqueOrThrow({where: {projectId}});
    expect(row.brand).toEqual({...BRAND_DEFAULTS, button: BUTTON_DEFAULTS});
  });

  it('reads a row edited by hand through the same allowlist', async () => {
    await prisma.plunkLiteProjectBrand.create({
      data: {projectId, brand: {textColor: 'url(x)', linkColor: '#0A7C3E', contentWidth: 10_000}},
    });

    expect(await BrandService.get(projectId)).toEqual({
      ...BRAND_DEFAULTS,
      linkColor: '#0a7c3e',
      button: BUTTON_DEFAULTS,
    });
  });

  it("keeps each project's brand to itself", async () => {
    const {project: other} = await factories.createUserWithProject();
    await BrandService.save(projectId, {textColor: '#111111'});

    expect((await BrandService.get(other.id)).textColor).toBe(BRAND_DEFAULTS.textColor);
  });
});
