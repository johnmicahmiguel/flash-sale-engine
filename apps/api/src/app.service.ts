import { Injectable } from '@nestjs/common';
import type { HelloResponse } from '@flash-sale/shared-types';

@Injectable()
export class AppService {
  getHello(): HelloResponse {
    return { message: 'Hello World!' };
  }
}
