import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { diskStorage } from 'multer';
import { ZipFile } from 'yazl';
import { CurrentClient } from '../auth/auth.guard';
import type { Client } from '../auth/clients.service';
import { loadEnv } from '../config/env';
import { SettingsService } from '../settings/settings.service';
import { JobsService } from './jobs.service';

type Files = Record<string, Express.Multer.File[] | undefined>;
type Fields = {
  callbackUrl?: string;
  externalId?: string;
  priority?: string;
  threshold?: string;
  tiles?: string;
  context?: string;
};

const MAX_PER_FIELD = 5000;

function uploads() {
  const env = loadEnv();
  const tmp = join(env.dataDir, 'tmp');
  mkdirSync(tmp, { recursive: true });
  return {
    storage: diskStorage({ destination: tmp }),
    limits: {
      fileSize: env.maxUploadMb * 1024 * 1024,
      files: MAX_PER_FIELD * 2,
    },
  };
}

async function discard(files: Files) {
  await Promise.all(
    Object.values(files)
      .flat()
      .filter((f): f is Express.Multer.File => !!f)
      .map((f) => rm(f.path, { force: true })),
  );
}

function optionalNumber(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new BadRequestException(`${name}: de ${min} a ${max}.`);
  return n;
}

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly settings: SettingsService,
  ) {}

  @Post('detect')
  @UseInterceptors(
    FileFieldsInterceptor(
      [{ name: 'pages', maxCount: MAX_PER_FIELD }],
      uploads(),
    ),
  )
  async detect(
    @CurrentClient() client: Client,
    @UploadedFiles() files: Files,
    @Body() body: Fields,
  ) {
    try {
      const pages = files.pages ?? [];
      if (pages.length > loadEnv().maxFiles)
        throw new BadRequestException(
          `No máximo ${loadEnv().maxFiles} páginas por job.`,
        );
      await this.jobs.assertDisk();
      const s = await this.settings.get();
      const threshold =
        optionalNumber(body.threshold, 'threshold', 0.05, 0.99) ??
        (s.detect_threshold as number);
      const tiles =
        body.tiles === undefined || body.tiles === ''
          ? true
          : !['false', '0', 'no'].includes(body.tiles.toLowerCase());
      return await this.jobs.create({
        type: 'detect',
        client,
        inputs: pages.map((f) => ({ name: f.originalname, path: f.path })),
        callbackUrl: body.callbackUrl,
        externalId: body.externalId,
        priority: body.priority,
        params: { threshold, tiles },
      });
    } catch (err) {
      await discard(files);
      throw err;
    }
  }

  @Post('inpaint')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'images', maxCount: MAX_PER_FIELD },
        { name: 'masks', maxCount: MAX_PER_FIELD },
      ],
      uploads(),
    ),
  )
  async inpaint(
    @CurrentClient() client: Client,
    @UploadedFiles() files: Files,
    @Body() body: Fields,
  ) {
    try {
      const images = files.images ?? [];
      const masks = files.masks ?? [];
      if (images.length !== masks.length)
        throw new BadRequestException(
          `Cada imagem precisa de uma máscara na mesma ordem: ${images.length} imagens e ${masks.length} máscaras.`,
        );
      if (images.length > loadEnv().maxFiles)
        throw new BadRequestException(
          `No máximo ${loadEnv().maxFiles} imagens por job.`,
        );
      await this.jobs.assertDisk();
      const s = await this.settings.get();
      const context =
        optionalNumber(body.context, 'context', 0, 1000) ??
        (s.lama_context as number);
      return await this.jobs.create({
        type: 'inpaint',
        client,
        inputs: images.map((f, i) => ({
          name: f.originalname,
          path: f.path,
          maskPath: masks[i].path,
        })),
        callbackUrl: body.callbackUrl,
        externalId: body.externalId,
        priority: body.priority,
        params: { context: Math.round(context) },
      });
    } catch (err) {
      await discard(files);
      throw err;
    }
  }

  @Get(':id')
  detail(@CurrentClient() client: Client, @Param('id') id: string) {
    return this.jobs.detail(id, client);
  }

  @Get(':id/files.zip')
  async zip(
    @CurrentClient() client: Client,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const files = await this.jobs.outputFiles(id, client);
    const zip = new ZipFile();
    for (const f of files) zip.addFile(f.path, f.name, { compress: false });
    zip.end();
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename="${id}.zip"`);
    zip.outputStream.pipe(res);
  }

  @Get(':id/files/:name')
  async file(
    @CurrentClient() client: Client,
    @Param('id') id: string,
    @Param('name') name: string,
    @Res() res: Response,
  ) {
    res.sendFile(await this.jobs.outputFile(id, client, name));
  }

  @Delete(':id')
  cancel(@CurrentClient() client: Client, @Param('id') id: string) {
    return this.jobs.cancel(id, client);
  }
}
