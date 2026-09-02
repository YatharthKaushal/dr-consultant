import { Controller, Get, Query } from '@nestjs/common';
import { AccountType } from '../../shared/auth/auth.decorator';
import { ListConcernsQueryDto } from './concern.dto';
import { ConcernService } from './concern.service';

/** No logic here — parse, authorise via decorators, delegate. Any authenticated account type. */
@Controller('concerns')
@AccountType('patient', 'doctor', 'admin')
export class ConcernController {
  constructor(private readonly service: ConcernService) {}

  /** Active concerns only, optionally filtered by specialty. */
  @Get()
  list(@Query() query: ListConcernsQueryDto) {
    return this.service.listActive(query.specialtyId);
  }
}
