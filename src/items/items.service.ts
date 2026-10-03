import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CreateItemDto } from './dto/create-item.dto.js';
import { UpdateItemDto } from './dto/update-item.dto.js';
import { Item, ItemDocument } from './schemas/item.schema.js';

@Injectable()
export class ItemsService {
  constructor(@InjectModel(Item.name) private readonly model: Model<Item>) {}

  create(dto: CreateItemDto): Promise<ItemDocument> {
    return this.model.create(dto);
  }

  findAll(): Promise<ItemDocument[]> {
    return this.model.find().exec();
  }

  async findOne(id: string): Promise<ItemDocument> {
    const item = await this.model.findById(id).exec();
    if (!item) throw new NotFoundException(`Item ${id} not found`);
    return item;
  }

  async update(id: string, dto: UpdateItemDto): Promise<ItemDocument> {
    const item = await this.model
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!item) throw new NotFoundException(`Item ${id} not found`);
    return item;
  }

  async remove(id: string): Promise<void> {
    const res = await this.model.findByIdAndDelete(id).exec();
    if (!res) throw new NotFoundException(`Item ${id} not found`);
  }
}
