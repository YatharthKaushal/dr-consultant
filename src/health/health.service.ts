import { Injectable } from '@nestjs/common';

export interface HealthStatus {
  status: 'ok';
  service: string;
  uptime: number;
  timestamp: string;
}

@Injectable()
export class HealthService {
  check(): HealthStatus {
    return {
      status: 'ok',
      service: 'dr-consultation-backend',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
