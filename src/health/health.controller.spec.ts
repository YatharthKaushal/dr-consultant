import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [HealthService],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should return an ok status', () => {
    const result = controller.check();

    expect(result.status).toBe('ok');
    expect(result.service).toBe('dr-consultation-backend');
    expect(typeof result.uptime).toBe('number');
    expect(new Date(result.timestamp).toString()).not.toBe('Invalid Date');
  });
});
