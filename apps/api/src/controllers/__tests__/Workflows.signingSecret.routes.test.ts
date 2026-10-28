import {Server} from '@overnightjs/core';
import {WorkflowStepType} from '@plunk/db';
import cookies from 'cookie-parser';
import {json, type NextFunction, type Request, type Response} from 'express';
import request from 'supertest';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {DASHBOARD_URI} from '../../app/constants';
import {HttpException} from '../../exceptions/index';
import {jwt} from '../../middleware/auth';
import {Workflows} from '../Workflows';

/** The workflow routes behind their real middlewares, with the API's status for an HttpException */
function createApp() {
  const server = new (class extends Server {})();
  server.app.use(json());
  server.app.use(cookies());
  server.addControllers([new Workflows()]);
  server.app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error instanceof HttpException ? error.code : 500).json({success: false});
  });
  return server.app;
}

/**
 * Plunk Lite: the signing secret of a webhook step can only be set by the project it belongs to --
 * with its secret key, or a dashboard session from the dashboard's own origin.
 */
describe('PUT /workflows/:id/steps/:stepId/signing-secret, behind its middlewares', () => {
  const prisma = getPrismaClient();
  const app = createApp();
  const secret = 'Zx9_-'.repeat(8);
  let project: {id: string; secret: string};
  let session: string;
  let path: string;

  beforeEach(async () => {
    const created = await factories.createUserWithProject();
    project = created.project;
    await prisma.user.update({where: {id: created.user.id}, data: {emailVerified: true}});
    session = `next_token=${jwt.sign(created.user.id)}`;

    const workflow = await factories.createWorkflow({projectId: project.id});
    const step = await factories.createWorkflowStep({workflowId: workflow.id, type: WorkflowStepType.WEBHOOK});
    path = `/workflows/${workflow.id}/steps/${step.id}/signing-secret`;
  });

  it('takes it from the project secret key', async () => {
    const res = await request(app).put(path).set('Authorization', `Bearer ${project.secret}`).send({secret});

    expect(res.status).toBe(204);
    expect(await prisma.plunkLiteWebhookSecret.count()).toBe(1);
  });

  it('takes it from a dashboard session on the dashboard origin', async () => {
    const res = await request(app)
      .put(path)
      .set('Cookie', session)
      .set('X-Project-Id', project.id)
      .set('Origin', DASHBOARD_URI)
      .send({secret});

    expect(res.status).toBe(204);
  });

  it('refuses a session from another origin, before reading it', async () => {
    const res = await request(app)
      .put(path)
      .set('Cookie', session)
      .set('X-Project-Id', project.id)
      .set('Origin', 'https://evil.example')
      .send({secret});

    expect(res.status).toBe(403);
    expect(await prisma.plunkLiteWebhookSecret.count()).toBe(0);
  });

  it('refuses a request with no credentials', async () => {
    const res = await request(app).put(path).send({secret});

    expect(res.status).toBe(401);
    expect(await prisma.plunkLiteWebhookSecret.count()).toBe(0);
  });

  it("answers 404 to another project's key, with nothing written", async () => {
    const other = await factories.createUserWithProject();

    const res = await request(app).put(path).set('Authorization', `Bearer ${other.project.secret}`).send({secret});

    expect(res.status).toBe(404);
    expect(await prisma.plunkLiteWebhookSecret.count()).toBe(0);
  });
});
