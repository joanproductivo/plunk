import {afterEach, describe, expect, it, vi} from 'vitest';

interface SentCommand {
  name: string;
  input: Record<string, string>;
}

const sent = vi.hoisted(() => [] as SentCommand[]);
// Replies to list requests, one per page, in order
const listReplies = vi.hoisted(() => [] as unknown[]);

vi.mock('@aws-sdk/client-s3', () => {
  const command = (name: string) =>
    class {
      readonly name = name;
      constructor(readonly input: Record<string, string>) {}
    };

  return {
    S3Client: class {
      async send(sentCommand: SentCommand) {
        sent.push(sentCommand);
        return sentCommand.name === 'ListObjectsV2' ? (listReplies.shift() ?? {}) : {};
      }
    },
    CreateBucketCommand: command('CreateBucket'),
    HeadBucketCommand: command('HeadBucket'),
    ListObjectsV2Command: command('ListObjectsV2'),
    PutBucketPolicyCommand: command('PutBucketPolicy'),
    PutObjectCommand: command('PutObject'),
  };
});

// constants.ts reads the environment at import time, so each case stubs the
// S3 variables and imports a fresh copy of the service.
async function loadS3Service(prefix: string) {
  vi.resetModules();
  vi.stubEnv('S3_ACCESS_KEY_ID', 'test-access-key');
  vi.stubEnv('S3_ACCESS_KEY_SECRET', 'test-secret');
  vi.stubEnv('S3_BUCKET', 'shared-bucket');
  vi.stubEnv('S3_PUBLIC_URL', 'https://cdn.example.com');
  vi.stubEnv('S3_PREFIX', prefix);

  return import('../S3Service.js');
}

function uploadImage(S3Service: Awaited<ReturnType<typeof loadS3Service>>) {
  return S3Service.uploadFile({
    file: Buffer.from('image'),
    filename: 'logo.png',
    contentType: 'image/png',
    projectId: 'project-1',
  });
}

function sentInput(name: string) {
  return sent.find(command => command.name === name)?.input;
}

function publicReadResources() {
  const policy = JSON.parse(sentInput('PutBucketPolicy')?.Policy ?? '{}') as {
    Statement: {Resource: string[]}[];
  };
  return policy.Statement.flatMap(statement => statement.Resource);
}

describe('S3Service', () => {
  afterEach(() => {
    sent.length = 0;
    listReplies.length = 0;
    vi.unstubAllEnvs();
  });

  describe('uploadFile', () => {
    it('stores objects under the project folder when no prefix is configured', async () => {
      const S3Service = await loadS3Service('');

      const {key, url} = await uploadImage(S3Service);

      expect(key).toMatch(/^project-1\/\d+-[0-9a-f]{16}-logo\.png$/);
      expect(url).toBe(`https://cdn.example.com/${key}`);
      expect(sentInput('PutObject')).toMatchObject({
        Bucket: 'shared-bucket',
        Key: key,
      });
    });

    it('stores objects under S3_PREFIX when configured', async () => {
      const S3Service = await loadS3Service('plunk');

      const {key, url} = await uploadImage(S3Service);

      expect(key).toMatch(/^plunk\/project-1\/\d+-[0-9a-f]{16}-logo\.png$/);
      expect(url).toBe(`https://cdn.example.com/${key}`);
      expect(sentInput('PutObject')).toMatchObject({
        Bucket: 'shared-bucket',
        Key: key,
      });
    });

    it('names the object after its content type, not the file name it was sent with', async () => {
      const S3Service = await loadS3Service('');
      const upload = (filename: string, contentType: string) =>
        S3Service.uploadFile({file: Buffer.from('image'), filename, contentType, projectId: 'project-1'});

      expect((await upload('photo.JPG', 'image/jpeg')).key).toMatch(/\.jpg$/);
      expect((await upload('photo.jfif', 'image/jpg')).key).toMatch(/\.jpg$/);
      expect((await upload('picture', 'image/webp')).key).toMatch(/\.webp$/);
      expect((await upload('page.html', 'image/gif')).key).toMatch(/\.gif$/);
      await expect(upload('page.html', 'text/html')).rejects.toThrow('Unsupported upload type');
    });

    it('keeps the original name in the key as a slug, read back by uploadNameFromKey', async () => {
      const S3Service = await loadS3Service('');
      const keyFor = async (filename: string) =>
        (await S3Service.uploadFile({file: Buffer.from('image'), filename, contentType: 'image/png', projectId: 'p'}))
          .key;

      expect(await keyFor('Café niño.png')).toMatch(/^p\/\d+-[0-9a-f]{16}-cafe-nino\.png$/);
      expect(await keyFor('€€€.png')).toMatch(/^p\/\d+-[0-9a-f]{16}\.png$/);
      expect(await keyFor('no-extension')).toMatch(/-no-extension\.png$/);

      expect(S3Service.uploadNameFromKey(await keyFor('Café niño.png'))).toBe('cafe-nino');
      expect(S3Service.uploadNameFromKey(await keyFor('€€€.png'))).toBeNull();
      // Keys from before names were kept, whatever their extension
      expect(S3Service.uploadNameFromKey('p/1761400000000-0123456789abcdef.JPG')).toBeNull();
      expect(S3Service.uploadNameFromKey('p/1761400000000-0123456789abcdef.foto final')).toBeNull();
    });

    it('refuses content types that are not images, names on every object included', async () => {
      const S3Service = await loadS3Service('');

      for (const contentType of ['text/html', 'constructor', 'toString']) {
        await expect(
          S3Service.uploadFile({file: Buffer.from('x'), filename: 'x', contentType, projectId: 'project-1'}),
        ).rejects.toThrow('Unsupported upload type');
      }
      expect(S3Service.isImageType('constructor')).toBe(false);
      expect(sentInput('PutObject')).toBeUndefined();
    });

    it('stores files to link in a folder of their own, named after the file when saved', async () => {
      const S3Service = await loadS3Service('plunk');

      const {key, url} = await S3Service.uploadFile({
        file: Buffer.from('%PDF-1.7'),
        filename: "Guía 'final' (v2) *.pdf",
        contentType: 'application/pdf',
        projectId: 'project-1',
      });

      expect(key).toMatch(/^plunk\/files\/project-1\/\d+-[0-9a-f]{16}-guia-final-v2\.pdf$/);
      expect(url).toBe(`https://cdn.example.com/${key}`);
      expect(sentInput('PutObject')).toMatchObject({
        Key: key,
        ContentType: 'application/pdf',
        ContentDisposition: `inline; filename="Gu_a 'final' (v2) *.pdf"; filename*=UTF-8''Gu%C3%ADa%20%27final%27%20%28v2%29%20%2A.pdf`,
      });
    });

    it('cuts a long name, keeping its extension', async () => {
      const S3Service = await loadS3Service('');

      await S3Service.uploadFile({
        file: Buffer.from('%PDF-1.7'),
        filename: `${'a'.repeat(300)}.pdf`,
        contentType: 'application/pdf',
        projectId: 'project-1',
      });

      expect(sentInput('PutObject')?.ContentDisposition).toBe(
        `inline; filename="${'a'.repeat(146)}.pdf"; filename*=UTF-8''${'a'.repeat(146)}.pdf`,
      );
    });

    it('opens images without naming them', async () => {
      const S3Service = await loadS3Service('');

      await uploadImage(S3Service);

      expect(sentInput('PutObject')).not.toHaveProperty('ContentDisposition');
    });

    it('ignores leading and trailing slashes in S3_PREFIX', async () => {
      const S3Service = await loadS3Service('/tenants/plunk/');

      const {key} = await uploadImage(S3Service);

      expect(key).toMatch(/^tenants\/plunk\/project-1\/\d+-[0-9a-f]{16}-logo\.png$/);
    });
  });

  describe('listUploads', () => {
    const object = (time: number, name = '', extension = 'png') => ({
      Key: `project-1/${time}-0123456789abcdef${name && `-${name}`}.${extension}`,
      LastModified: new Date(time),
      Size: 100,
    });
    const listRequests = () => sent.filter(command => command.name === 'ListObjectsV2');

    it("lists only the project's folder, latest first, with public URLs and names", async () => {
      const S3Service = await loadS3Service('plunk');
      listReplies.push({Contents: [object(1000, 'old'), object(3000, 'new'), object(2000)], IsTruncated: false});

      const {uploads: images, truncated} = await S3Service.listUploads('image', 'project-1');

      expect(sentInput('ListObjectsV2')).toMatchObject({Bucket: 'shared-bucket', Prefix: 'plunk/project-1/'});
      expect(images.map(image => image.name)).toEqual(['new', null, 'old']);
      expect(images[0]).toEqual({
        url: 'https://cdn.example.com/project-1/3000-0123456789abcdef-new.png',
        name: 'new',
        uploadedAt: new Date(3000).toISOString(),
        size: 100,
      });
      expect(truncated).toBe(false);
    });

    it("lists files from their own folder, apart from the project's images", async () => {
      const S3Service = await loadS3Service('plunk');
      listReplies.push({Contents: [{Key: 'plunk/files/project-1/1000-0123456789abcdef-guide.pdf', Size: 5}]});

      const {uploads} = await S3Service.listUploads('file', 'project-1');

      expect(sentInput('ListObjectsV2')).toMatchObject({Prefix: 'plunk/files/project-1/'});
      expect(uploads).toEqual([
        {
          url: 'https://cdn.example.com/plunk/files/project-1/1000-0123456789abcdef-guide.pdf',
          name: 'guide',
          uploadedAt: null,
          size: 5,
        },
      ]);
    });

    it('reads every page, keeping the latest 1000', async () => {
      const S3Service = await loadS3Service('');
      const page = (from: number) => Array.from({length: 1000}, (_, index) => object(1_000_000 + from + index));
      listReplies.push(
        {Contents: page(0), IsTruncated: true, NextContinuationToken: 'two'},
        {Contents: page(1000), IsTruncated: true, NextContinuationToken: 'three'},
        {Contents: page(2000).slice(0, 10), IsTruncated: false},
      );

      const {uploads: images, truncated} = await S3Service.listUploads('image', 'project-1');

      expect(listRequests().map(command => command.input.ContinuationToken)).toEqual([undefined, 'two', 'three']);
      expect(images).toHaveLength(1000);
      expect(images[0]!.url).toContain(`/${1_000_000 + 2009}-`);
      expect(truncated).toBe(true);
    });

    it('reads 50 pages at most, and says the list is cut short', async () => {
      const S3Service = await loadS3Service('');
      for (let page = 0; page < 60; page++) {
        listReplies.push({
          Contents: [object(1000 + page)],
          IsTruncated: true,
          NextContinuationToken: `page-${page + 1}`,
        });
      }

      const {uploads: images, truncated} = await S3Service.listUploads('image', 'project-1');

      expect(listRequests()).toHaveLength(50);
      expect(images).toHaveLength(50);
      expect(truncated).toBe(true);
    });

    it('stops when a page claims more but gives no token, and skips folder markers', async () => {
      const S3Service = await loadS3Service('');
      listReplies.push({Contents: [object(1000), {Key: 'project-1/', Size: 0}], IsTruncated: true});

      const {uploads: images} = await S3Service.listUploads('image', 'project-1');

      expect(listRequests()).toHaveLength(1);
      expect(images).toHaveLength(1);
    });

    it('encodes older keys that took odd extensions from the file name', async () => {
      const S3Service = await loadS3Service('');
      listReplies.push({Contents: [object(1000, '', 'foto final')]});

      const {uploads: images} = await S3Service.listUploads('image', 'project-1');

      expect(images[0]!.url).toBe('https://cdn.example.com/project-1/1000-0123456789abcdef.foto%20final');
    });
  });

  describe('linkedFileType', () => {
    it('takes the type from the extension, when the browser sent that type or none', async () => {
      const S3Service = await loadS3Service('');
      const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

      expect(S3Service.linkedFileType('Guide.PDF', 'application/pdf')).toBe('application/pdf');
      expect(S3Service.linkedFileType('notes.docx', 'application/octet-stream')).toBe(docx);
      expect(S3Service.linkedFileType('notes.docx', 'application/zip')).toBe(docx);
      expect(S3Service.linkedFileType('notes.docx', 'text/html')).toBeNull();
      expect(S3Service.linkedFileType('page.html', 'text/html')).toBeNull();
      expect(S3Service.linkedFileType('macro.docm', 'application/octet-stream')).toBeNull();
      expect(S3Service.linkedFileType('photo.png', 'image/png')).toBeNull();
      expect(S3Service.linkedFileType('no-extension', 'application/pdf')).toBeNull();
    });
  });

  describe('hasContentsOf', () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const zip = (...names: string[]) =>
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), ...names.map(n => Buffer.from(n))]);

    it('checks how images and PDFs start', async () => {
      const S3Service = await loadS3Service('');

      expect(S3Service.hasContentsOf(Buffer.from('%PDF-1.7 …'), 'application/pdf')).toBe(true);
      expect(S3Service.hasContentsOf(Buffer.from('<html>'), 'application/pdf')).toBe(false);
      expect(S3Service.hasContentsOf(Buffer.from('GIF89a…'), 'image/gif')).toBe(true);
      expect(S3Service.hasContentsOf(Buffer.from('GIF89a…'), 'image/png')).toBe(false);
      expect(S3Service.hasContentsOf(Buffer.from('%PDF-'), 'constructor')).toBe(false);
    });

    it('takes Office documents, not other ZIP files nor macro-enabled documents', async () => {
      const S3Service = await loadS3Service('');

      expect(S3Service.hasContentsOf(zip('[Content_Types].xml', 'word/document.xml'), docx)).toBe(true);
      expect(S3Service.hasContentsOf(zip('setup.exe'), docx)).toBe(false);
      expect(S3Service.hasContentsOf(zip('[Content_Types].xml', 'word/vbaProject.bin'), docx)).toBe(false);
    });
  });

  describe('initializeBucket', () => {
    it('grants public read on the whole bucket when no prefix is configured', async () => {
      const S3Service = await loadS3Service('');

      await S3Service.initializeBucket();

      expect(publicReadResources()).toEqual(['arn:aws:s3:::shared-bucket/*']);
    });

    it('limits public read to S3_PREFIX when configured', async () => {
      const S3Service = await loadS3Service('plunk');

      await S3Service.initializeBucket();

      expect(publicReadResources()).toEqual(['arn:aws:s3:::shared-bucket/plunk/*']);
    });
  });
});
