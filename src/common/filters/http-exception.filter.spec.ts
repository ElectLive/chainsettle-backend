import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { I18nService } from '../../i18n/i18n.service';
import { requestIdStorage } from '../middleware/request-id.middleware';
import { buildErrorBody, HttpExceptionFilter } from './http-exception.filter';

type MockResponse = {
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
  headers: Record<string, unknown>;
  statusCode?: number;
  body?: any;
};

function createResponse(): MockResponse {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn(),
    headers: {} as Record<string, unknown>,
  } as unknown as MockResponse;

  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json.mockImplementation((payload: unknown) => {
    res.body = payload;
    return res;
  });
  res.setHeader.mockImplementation((name: string, value: unknown) => {
    res.headers[name] = value;
    return res;
  });

  return res;
}

interface HostOptions {
  url?: string;
  method?: string;
  locale?: string;
  acceptLanguage?: string | string[];
  requestId?: string;
}

function createHost(options: HostOptions = {}) {
  const res = createResponse();
  const request: any = {
    url: options.url ?? '/api/v1/shipments/abc',
    method: options.method ?? 'GET',
    headers:
      options.acceptLanguage === undefined
        ? {}
        : { 'accept-language': options.acceptLanguage },
    locale: options.locale,
    id: options.requestId,
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, res, request };
}

describe('HttpExceptionFilter (#526)', () => {
  let i18n: I18nService;
  let filter: HttpExceptionFilter;
  let logError: jest.SpyInstance;

  beforeEach(() => {
    i18n = new I18nService();
    filter = new HttpExceptionFilter(i18n);
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('buildErrorBody', () => {
    it('builds the standard envelope with an ISO timestamp', () => {
      const body = buildErrorBody(418, '/api/v1/teapot', 'short and stout');

      expect(body).toMatchObject({
        success: false,
        statusCode: 418,
        path: '/api/v1/teapot',
        message: 'short and stout',
      });
      expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    });
  });

  describe('HttpException mapping', () => {
    it('maps a NotFoundException to 404 and keeps the service message', () => {
      const { host, res } = createHost({ url: '/api/v1/shipments/abc' });

      filter.catch(new NotFoundException('Shipment abc not found'), host);

      expect(res.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(res.statusCode).toBe(HttpStatus.NOT_FOUND);
      expect(res.json).toHaveBeenCalledTimes(1);
      expect(res.body).toMatchObject({
        success: false,
        statusCode: HttpStatus.NOT_FOUND,
        path: '/api/v1/shipments/abc',
      });
      expect(res.body.message).toContain('abc');
      expect(logError).not.toHaveBeenCalled();
    });

    it('preserves the validation message array from the ValidationPipe', () => {
      const { host, res } = createHost({ url: '/api/v1/shipments', method: 'POST' });

      filter.catch(
        new BadRequestException({
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          message: [
            'amount must be a positive number',
            'buyerAddress must be a Stellar address',
          ],
        }),
        host,
      );

      expect(res.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(res.body.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toEqual([
        'amount must be a positive number',
        'buyerAddress must be a Stellar address',
      ]);
    });

    it('handles an exception whose payload is the default object shape', () => {
      const { host, res } = createHost();

      filter.catch(new ForbiddenException(), host);

      expect(res.statusCode).toBe(HttpStatus.FORBIDDEN);
      expect(res.body.message).toBe('Forbidden');
      expect(logError).not.toHaveBeenCalled();
    });

    it('passes a non-string, non-object payload through unchanged', () => {
      const { host, res } = createHost();

      filter.catch(new HttpException(42 as any, HttpStatus.BAD_REQUEST), host);

      expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toBe(42);
    });

    it('translates an i18n key thrown directly by a service', () => {
      const { host, res } = createHost();

      filter.catch(
        new HttpException('errors.ONLY_BUYER_MAY_CONFIRM', HttpStatus.FORBIDDEN),
        host,
      );

      expect(res.body.statusCode).toBe(HttpStatus.FORBIDDEN);
      expect(res.body.message).toBe(i18n.t('errors.ONLY_BUYER_MAY_CONFIRM', 'en'));
      expect(res.body.message).not.toBe('errors.ONLY_BUYER_MAY_CONFIRM');
    });
  });

  describe('unexpected errors', () => {
    it('answers 500 with a generic message and logs the stack instead', () => {
      const { host, res } = createHost({ url: '/api/v1/shipments', method: 'POST' });
      const dbError = new Error('prisma: connect failed postgres://user:hunter2@db');

      filter.catch(dbError, host);

      expect(res.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(res.body).toMatchObject({
        success: false,
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        path: '/api/v1/shipments',
        message: 'Internal server error',
      });

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('prisma: connect failed');
      expect(serialized).not.toMatch(/\bat\s.+:\d+:\d+/);

      expect(logError).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledWith(
        'POST /api/v1/shipments',
        expect.stringContaining('hunter2'),
      );
    });

    it('keeps non-Error throwables generic and still logs them', () => {
      const { host, res } = createHost();

      filter.catch('boom', host);

      expect(res.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(res.body.message).toBe('Internal server error');
      expect(logError).toHaveBeenCalledWith('GET /api/v1/shipments/abc', 'boom');
    });
  });

  describe('body-parser style errors', () => {
    it('maps entity.too.large to 413 without echoing the parser text', () => {
      const { host, res } = createHost({ method: 'POST', url: '/api/v1/shipments/import' });
      const parserError: any = new Error('request entity too large');
      parserError.type = 'entity.too.large';
      parserError.status = 413;

      filter.catch(parserError, host);

      expect(res.statusCode).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
      expect(res.body).toMatchObject({
        success: false,
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        path: '/api/v1/shipments/import',
        message: 'Request body too large',
      });
      expect(logError).not.toHaveBeenCalled();
    });

    it('maps a 4xx status carried by an Error to that status', () => {
      const { host, res } = createHost({ method: 'POST', url: '/api/v1/shipments' });
      const parseError: any = new SyntaxError('Unexpected token } in JSON at position 0');
      parseError.type = 'entity.parse.failed';
      parseError.status = 400;

      filter.catch(parseError, host);

      expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toBe('Unexpected token } in JSON at position 0');
      expect(logError).not.toHaveBeenCalled();
    });
  });

  describe('locale resolution and translation', () => {
    const englishMessage = 'Only the shipment buyer may confirm milestones';

    it('translates a known English message using Accept-Language', () => {
      const { host, res } = createHost({ acceptLanguage: 'es-ES,es;q=0.9,en;q=0.5' });

      filter.catch(new ForbiddenException(englishMessage), host);

      expect(res.body.message).toBe(i18n.t('errors.ONLY_BUYER_MAY_CONFIRM', 'es'));
      expect(res.body.message).not.toBe(englishMessage);
    });

    it('prefers req.locale (set by LocaleMiddleware) over the header', () => {
      const { host, res } = createHost({ locale: 'es', acceptLanguage: 'en-US,en;q=0.9' });

      filter.catch(new ForbiddenException(englishMessage), host);

      expect(res.body.message).toBe(i18n.t('errors.ONLY_BUYER_MAY_CONFIRM', 'es'));
    });

    it('reads the first entry when accept-language arrives as an array', () => {
      const { host, res } = createHost({ acceptLanguage: ['es-MX', 'en'] });

      filter.catch(new ForbiddenException(englishMessage), host);

      expect(res.body.message).toBe(i18n.t('errors.ONLY_BUYER_MAY_CONFIRM', 'es'));
    });

    it('falls back to English for unsupported locales', () => {
      const { host, res } = createHost({ acceptLanguage: 'fr-FR' });

      filter.catch(new ForbiddenException(englishMessage), host);

      expect(res.body.message).toBe(englishMessage);
    });

    it('localizes the generic 500 message too', () => {
      const { host, res } = createHost({ locale: 'es' });

      filter.catch(new Error('kaboom'), host);

      expect(res.body.message).toBe(i18n.t('errors.INTERNAL_SERVER_ERROR', 'es'));
      expect(res.body.message).not.toBe('Internal server error');
    });

    it('resolves { i18nKey, args } payloads thrown by services', () => {
      const { host, res } = createHost({ locale: 'es' });

      filter.catch(
        new HttpException(
          { i18nKey: 'errors.SHIPMENT_NOT_FOUND', args: { id: 'shp-42' } },
          HttpStatus.NOT_FOUND,
        ),
        host,
      );

      expect(res.body.message).toBe(
        i18n.t('errors.SHIPMENT_NOT_FOUND', 'es', { id: 'shp-42' }),
      );
      expect(res.body.message).toContain('shp-42');
    });
  });

  describe('request correlation', () => {
    it('leaves the X-Request-ID header from RequestIdMiddleware untouched', () => {
      const { host, res, request } = createHost({ requestId: 'req-123' });
      res.setHeader('X-Request-ID', request.id);

      filter.catch(new NotFoundException('Shipment abc not found'), host);

      expect(res.headers['X-Request-ID']).toBe('req-123');
      expect(res.setHeader).toHaveBeenCalledTimes(1);
    });

    it('runs inside the async request-id context so logs and traces still correlate', () => {
      const { host, res } = createHost({ requestId: 'req-456' });
      let storeDuringHandling: string | undefined;

      requestIdStorage.run('req-456', () => {
        filter.catch(new Error('db down'), host);
        storeDuringHandling = requestIdStorage.getStore();
      });

      expect(storeDuringHandling).toBe('req-456');
      expect(res.body.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    });
  });
});
