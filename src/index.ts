import { envelop, useLogger, useSchema, useTiming } from '@envelop/core';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { registerSocketIOGraphQLServer } from "@n1ru4l/socket-io-graphql-server";
import { PrismaClient } from '@prisma/client';
import fastify from 'fastify';
import fs from 'fs';
import { GraphQLError } from 'graphql';
import { getGraphQLParameters, processRequest, renderGraphiQL, shouldRenderGraphiQL } from 'graphql-helix';
import { useServer } from 'graphql-ws/lib/use/ws';
import * as http from "http";
import path from 'path';
import { Server as IOServer } from "socket.io";
import { Server as WSServer } from "ws";
import { Link, Mutation, Query, Subscription, User, Vote } from './resolvers/index.js';
import { getUserId } from './utils.js';

const prisma = new PrismaClient({
  errorFormat: 'minimal'
});

const resolvers = {
  Query,
  Mutation,
  Subscription,
  User,
  Link,
  Vote
};

const typeDefs = fs.readFileSync(path.join(__dirname, '../schema.graphql'),'utf8');

const schema = makeExecutableSchema({
  typeDefs: typeDefs,
  resolvers: resolvers,
});

const getEnveloped = envelop({
  plugins: [
    useSchema(schema), 
    useLogger(), 
    useTiming()
  ],
});

const { execute, subscribe, parse, validate, contextFactory } = getEnveloped();

const port = process.env.PORT || 4000;

const httpServer = http.createServer();

const app = fastify(httpServer);

app.listen(port, function(){
  console.log(`GraphQL server is running on port ${port}.`);
});

const wsServer = new WSServer({
  server: httpServer,
  path: "/graphql",
});

app.route({
  method: ['GET', 'POST'],
  url: '/graphql',
  async handler(req:any, res:any) {
    
    const request = {
      body: req.body,
      headers: req.headers,
      method: req.method,
      query: req.query,
    };

    if (shouldRenderGraphiQL(request)) {
      res.type('text/html');
      res.send(renderGraphiQL({

        subscriptionsEndpoint: "ws://localhost:4000/graphql",
      }));
    } else {
      const request = {
        body: req.body,
        headers: req.headers,
        method: req.method,
        query: req.query,
      };
      const { operationName, query, variables } = getGraphQLParameters(request);
      const result = await processRequest({
        operationName,
        query,
        variables,
        request,
        schema,
        parse,
        validate,
        execute,
        contextFactory: () => ({
          ...req,
          prisma,
          // pubsub,
          userId:
            req && req.headers.authorization
              ? getUserId(req)
              : null
        }),
        
      });

      if (result.type === 'RESPONSE') {
        result.headers.forEach(({ name, value }) => res.setHeader(name, value));
        res.status(result.status);
        res.send(result.payload);
      } else if (result.type === "MULTIPART_RESPONSE") {
        res.writeHead(200, {
          Connection: "keep-alive",
          "Content-Type": 'multipart/mixed; boundary="-"',
          "Transfer-Encoding": "chunked",
        });
    
        req.on("close", () => {
          result.unsubscribe();
        });
    
        res.write("---");
    
        await result.subscribe((result) => {
          const chunk = Buffer.from(JSON.stringify(result), "utf8");
          const data = [
            "",
            "Content-Type: application/json; charset=utf-8",
            "Content-Length: " + String(chunk.length),
            "",
            chunk,
          ];
    
          if (result.hasNext) {
            data.push("---");
          }
    
          res.write(data.join("\r\n"));
        });
    
        res.write("\r\n-----\r\n");
        res.end();
      } else {
        res.status(422);
        res.send({
          errors: [
            new GraphQLError("Subscriptions should be sent over WebSocket."),
          ],
        });
      }
    }
  },
});


const graphqlWs = useServer(
  {
    execute,
    subscribe,
    onSubscribe: async (ctx, msg) => {
      const { schema } = getEnveloped();

      const args = {
        schema,
        operationName: msg.payload.operationName,
        document: parse(msg.payload.query),
        variableValues: msg.payload.variables,
        contextValue: await contextFactory({
          connectionParams: ctx.connectionParams,
          socket: ctx.extra.socket,
          request: ctx.extra.request,
        }),
      };

      const errors = validate(args.schema, args.document);
      if (errors.length) return errors;

      return args;
    },
    onConnect: (connectionParams:any) => {
      if (connectionParams.authToken) {
        return {
          prisma,
          userId: getUserId(
            null,
            connectionParams.authToken
          )
        };
      } else {
        return {
          prisma
        };
      }
    }
  },
  wsServer
);

// Starting a Socket.io server that serves the GraphQL schema

const socketIoHttpServer = http.createServer();
const ioServer = new IOServer(socketIoHttpServer, {
  cors: {
    origin: "*",
  },
});

registerSocketIOGraphQLServer({
  socketServer: ioServer,
  getParameter: () => ({
    execute: execute,
    graphQLExecutionParameter: {
      schema,
      // contextValue: context,
    },
  }),
});

socketIoHttpServer.listen(4001);

process.once("SIGINT", () => {
  console.log("Received SIGINT. Shutting down HTTP and Websocket server.");
  graphqlWs.dispose();
  httpServer.close();
  ioServer.close();
  socketIoHttpServer.close();
});