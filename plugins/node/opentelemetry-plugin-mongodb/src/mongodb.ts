/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { BasePlugin } from '@opentelemetry/core';
import {
  getSpan,
  StatusCode,
  Span,
  SpanKind,
  context,
} from '@opentelemetry/api';
import type * as mongodb from 'mongodb';
import * as shimmer from 'shimmer';
import {
  Func,
  MongodbCommandType,
  MongoInternalCommand,
  MongoInternalTopology,
} from './types';
import { VERSION } from './version';
import {
  DatabaseAttribute,
  GeneralAttribute,
} from '@opentelemetry/semantic-conventions';

/** MongoDBCore instrumentation plugin for OpenTelemetry */
export class MongoDBPlugin extends BasePlugin<typeof mongodb> {
  private readonly _SERVER_METHODS = ['insert', 'update', 'remove', 'command'];
  private readonly _CURSOR_METHODS = ['_next', 'next'];
  private _hasPatched: boolean = false;

  readonly supportedVersions = ['>=2 <4'];

  constructor(readonly moduleName: string) {
    super('@opentelemetry/plugin-mongodb-core', VERSION);
  }

  /**
   * Patches MongoDB operations.
   */
  protected patch() {
    this._logger.debug('Patching MongoDB');
    if (this._hasPatched === true) {
      this._logger.debug('Patch is already applied, ignoring.');
      return this._moduleExports;
    }

    if (this._moduleExports.Server) {
      for (const fn of this._SERVER_METHODS) {
        this._logger.debug(`patching mongodb.Server.prototype.${fn}`);
        shimmer.wrap(
          this._moduleExports.Server.prototype,
          // Forced to cast due to incomplete typings
          fn as any,
          this._getPatchCommand(fn)
        );
      }
    }

    if (this._moduleExports.Cursor) {
      this._logger.debug(
        'patching mongodb.Cursor.prototype functions:',
        this._CURSOR_METHODS
      );
      shimmer.massWrap(
        [this._moduleExports.Cursor.prototype],
        this._CURSOR_METHODS as never[],
        // tslint:disable-next-line:no-any
        this._getPatchCursor() as any
      );
    }

    this._hasPatched = true;
    return this._moduleExports;
  }

  /** Unpatches all MongoDB patched functions. */
  unpatch(): void {
    shimmer.massUnwrap(
      [this._moduleExports.Server.prototype],
      this._SERVER_METHODS as never[]
    );
    shimmer.massUnwrap(
      [this._moduleExports.Cursor.prototype],
      this._CURSOR_METHODS as never[]
    );
  }

  /** Creates spans for Command operations */
  private _getPatchCommand(operationName: string) {
    const plugin = this;
    return (original: Func<mongodb.Server>) => {
      return function patchedServerCommand(
        this: mongodb.Server,
        ns: string,
        commands: MongoInternalCommand[] | MongoInternalCommand,
        options: {} | Function,
        callback: Function
      ): mongodb.Server {
        const currentSpan = getSpan(context.active());
        const resultHandler =
          typeof options === 'function' ? options : callback;
        if (
          !currentSpan ||
          typeof resultHandler !== 'function' ||
          typeof commands !== 'object'
        ) {
          return original.apply(this, (arguments as unknown) as unknown[]);
        }
        const command = commands instanceof Array ? commands[0] : commands;
        const commandType = plugin._getCommandType(command);
        const type =
          commandType === MongodbCommandType.UNKNOWN
            ? operationName
            : commandType;
        const span = plugin._tracer.startSpan(`mongodb.${type}`, {
          kind: SpanKind.CLIENT,
        });
        plugin._populateAttributes(
          span,
          ns,
          command,
          this as MongoInternalTopology
        );
        return original.call(
          this,
          ns,
          commands,
          plugin._patchEnd(span, resultHandler)
        );
      };
    };
  }

  /**
   * Get the mongodb command type from the object.
   * @param command Internal mongodb command object
   */
  private _getCommandType(command: MongoInternalCommand): MongodbCommandType {
    if (command.createIndexes !== undefined) {
      return MongodbCommandType.CREATE_INDEXES;
    } else if (command.findandmodify !== undefined) {
      return MongodbCommandType.FIND_AND_MODIFY;
    } else if (command.ismaster !== undefined) {
      return MongodbCommandType.IS_MASTER;
    } else if (command.count !== undefined) {
      return MongodbCommandType.COUNT;
    } else {
      return MongodbCommandType.UNKNOWN;
    }
  }

  /**
   * Populate span's attributes by fetching related metadata from the context
   * @param span span to add attributes to
   * @param ns mongodb namespace
   * @param command mongodb internal representation of a command
   * @param topology mongodb internal representation of the network topology
   */
  private _populateAttributes(
    span: Span,
    ns: string,
    command: MongoInternalCommand,
    topology: MongoInternalTopology
  ) {
    // add network attributes to determine the remote server
    if (topology && topology.s) {
      span.setAttributes({
        [GeneralAttribute.NET_HOST_NAME]: `${
          topology.s.options?.host ?? topology.s.host
        }`,
        [GeneralAttribute.NET_HOST_PORT]: `${
          topology.s.options?.port ?? topology.s.port
        }`,
      });
    }

    // The namespace is a combination of the database name and the name of the
    // collection or index, like so: [database-name].[collection-or-index-name].
    // It could be a string or an instance of MongoDBNamespace, as such we
    // always coerce to a string to extract db and collection.
    const [dbName, dbCollection] = ns.toString().split('.');

    // add database related attributes
    span.setAttributes({
      [DatabaseAttribute.DB_SYSTEM]: 'mongodb',
      [DatabaseAttribute.DB_NAME]: dbName,
      [DatabaseAttribute.DB_MONGODB_COLLECTION]: dbCollection,
    });

    if (command === undefined) return;

    // capture parameters within the query as well if enhancedDatabaseReporting is enabled.
    const commandObj = command.query ?? command.q ?? command;
    const query =
      this._config?.enhancedDatabaseReporting === true
        ? commandObj
        : Object.keys(commandObj).reduce((obj, key) => {
            obj[key] = '?';
            return obj;
          }, {} as { [key: string]: unknown });

    span.setAttribute('db.statement', JSON.stringify(query));
  }

  /** Creates spans for Cursor operations */
  private _getPatchCursor() {
    const plugin = this;
    return (original: Func<mongodb.Cursor>) => {
      return function patchedCursorCommand(
        this: {
          ns: string;
          cmd: MongoInternalCommand;
          topology: MongoInternalTopology;
        },
        ...args: unknown[]
      ): mongodb.Cursor {
        const currentSpan = getSpan(context.active());
        const resultHandler = args[0];
        if (!currentSpan || typeof resultHandler !== 'function') {
          return original.apply(this, args);
        }
        const span = plugin._tracer.startSpan('mongodb.query', {
          kind: SpanKind.CLIENT,
        });
        plugin._populateAttributes(span, this.ns, this.cmd, this.topology);

        return original.call(this, plugin._patchEnd(span, resultHandler));
      };
    };
  }

  /**
   * Ends a created span.
   * @param span The created span to end.
   * @param resultHandler A callback function.
   */
  private _patchEnd(span: Span, resultHandler: Function): Function {
    return function patchedEnd(this: {}, ...args: unknown[]) {
      const error = args[0];
      if (error instanceof Error) {
        span.setStatus({
          code: StatusCode.ERROR,
          message: error.message,
        });
      }
      span.end();
      return resultHandler.apply(this, args);
    };
  }
}

export const plugin = new MongoDBPlugin('mongodb');
