import { Controller, Get, Param, Query } from '@nestjs/common';
import { AccountType } from '../../shared/auth/auth.decorator';
import { ListSlotsQueryDto } from './availability.dto';
import { AvailabilitySlotService } from './availability-slot.service';
import { uuidParam } from './availability-uuid.pipe';

/** A specific doctor's bookable slots, for a patient deciding when to book, a doctor checking their own public listing, or an admin — any authenticated account type, mirroring `specialty.controller.ts`'s explicit `@AccountType` class decorator. */
@Controller('doctors/:id/slots')
@AccountType('patient', 'doctor', 'admin')
export class AvailabilityPublicController {
  constructor(private readonly slotService: AvailabilitySlotService) {}

  @Get()
  getSlots(@Param('id', uuidParam()) id: string, @Query() query: ListSlotsQueryDto) {
    return this.slotService.listBookableSlots(id, new Date(query.from), new Date(query.to));
  }
}
