import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {prisma as servicePrisma} from '../../database/prisma';
import {ProjectFooterService} from '../ProjectFooterService';
import {factories, getPrismaClient} from '../../../../../test/helpers';

describe('ProjectFooterService', () => {
  const prisma = getPrismaClient();
  const footers = {es: {text: 'Hola', linkText: 'darte de baja'}};
  let projectId: string;

  beforeEach(async () => {
    ProjectFooterService.clearCache();
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('gives a project without footers of its own none, and remembers that', async () => {
    const read = vi.spyOn(servicePrisma.plunkLiteProjectFooters, 'findUnique');

    expect(await ProjectFooterService.get(projectId)).toEqual({});
    expect(await ProjectFooterService.get(projectId)).toEqual({});
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('saves footers and reads them back, replacing the previous ones', async () => {
    await ProjectFooterService.save(projectId, {de: {text: 'Hallo', linkText: 'abmelden'}});
    await ProjectFooterService.save(projectId, footers);
    ProjectFooterService.clearCache();

    expect(await ProjectFooterService.get(projectId)).toEqual(footers);
  });

  it('reads them again once a minute has passed', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    expect(await ProjectFooterService.get(projectId)).toEqual({});
    await prisma.plunkLiteProjectFooters.create({data: {projectId, footers}});

    expect(await ProjectFooterService.get(projectId)).toEqual({});
    vi.setSystemTime(Date.now() + 61_000);
    expect(await ProjectFooterService.get(projectId)).toEqual(footers);
  });

  it('reads a row edited by hand through the same checks', async () => {
    await prisma.plunkLiteProjectFooters.create({
      data: {projectId, footers: {...footers, xx: {text: 'x', linkText: 'leave'}, de: {text: 'Hallo', linkText: ''}}},
    });

    expect(await ProjectFooterService.get(projectId)).toEqual(footers);
  });

  it('only reads footers for marketing emails, and lets a failed read fail the email', async () => {
    expect(await ProjectFooterService.forEmail('transactional', projectId)).toBeUndefined();
    expect(await ProjectFooterService.forEmail('headless', projectId)).toBeUndefined();

    vi.spyOn(servicePrisma.plunkLiteProjectFooters, 'findUnique').mockRejectedValueOnce(new Error('database down'));
    await expect(ProjectFooterService.forEmail('marketing', projectId)).rejects.toThrow('database down');
  });
});
