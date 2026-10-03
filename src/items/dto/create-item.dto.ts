import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateItemDto {
  @ApiProperty({ example: 'Sample item' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 'Optional description' })
  @IsOptional()
  @IsString()
  description?: string;
}
