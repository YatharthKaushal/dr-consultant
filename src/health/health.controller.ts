import { Controller, Get } from '@nestjs/common';
import { Public } from '../shared/auth/auth.decorator';
import { HealthService, HealthStatus } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  // Load balancers / orchestrators hit this with no credentials — must stay
  // reachable now that JwtAuthGuard is registered globally.
  @Public()
  @Get()
  check(): HealthStatus {
    return this.healthService.check();
  }
}
