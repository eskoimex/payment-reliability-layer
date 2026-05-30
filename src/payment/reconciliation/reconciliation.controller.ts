import { Controller, Post, Body } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';

class ReconcileDto {
  startDate: string;
  endDate: string;
}

@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliationService: ReconciliationService) {}

  @Post()
  async reconcile(@Body() dto: ReconcileDto) {
    return this.reconciliationService.reconcile(new Date(dto.startDate), new Date(dto.endDate));
  }
}