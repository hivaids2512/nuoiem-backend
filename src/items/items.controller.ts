import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiNotFoundResponse, ApiTags } from '@nestjs/swagger';
import { CreateItemDto } from './dto/create-item.dto.js';
import { UpdateItemDto } from './dto/update-item.dto.js';
import { ItemsService } from './items.service.js';

@ApiTags('items')
@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Post()
  create(@Body() dto: CreateItemDto) {
    return this.items.create(dto);
  }

  @Get()
  findAll() {
    return this.items.findAll();
  }

  @ApiNotFoundResponse({ description: 'Item not found' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.items.findOne(id);
  }

  @ApiNotFoundResponse({ description: 'Item not found' })
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateItemDto) {
    return this.items.update(id, dto);
  }

  @ApiNotFoundResponse({ description: 'Item not found' })
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.items.remove(id);
  }
}
