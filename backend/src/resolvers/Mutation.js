const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('crypto');
const { promisify } = require('util');
const { makeANiceEmail } = require('../mail');
const nodemailer = require('nodemailer');
const { google } = require("googleapis");
const OAuth2 = google.auth.OAuth2;
const { hasPermission } = require('../utils');

const Mutations = {
    async createItem(parent, args, ctx, info) {
        if(!ctx.request.userId) {
            throw new Error('You must be logged in to create Item');
        }
        const item = await ctx.db.mutation.createItem({
            data: {
                user: {
                    connect: {
                        id: ctx.request.userId
                    }
                },
                ...args
            }
        }, info);
        return item;
    },
    updateItem(parent, args, ctx, info) {
        const updates = { ...args };
        delete updates.id;
        return ctx.db.mutation.updateItem({
            data: updates,
            where: {
                id: args.id
            }
        }, info)
    },
    async deleteItem(parent, args, ctx, info) {
        const where = { id: args.id };

        const item = await ctx.db.query.item({ where }, `{ id title user { id }}`);

        const ownsItem = item.user.id === ctx.request.userId;
        const hasPermissions = ctx.request.user.permissions.some(permission =>
        ['ADMIN', 'ITEMDELETE'].includes(permission)
        );

        if (!ownsItem && !hasPermissions) {
            throw new Error("You don't have permission to do that!");
          }

        return ctx.db.mutation.deleteItem({ where }, info);
    },
    async signup(parent, args, ctx, info) {
        args.email = args.email.toLowerCase();
        const password = await bcrypt.hash(args.password, 15);
        const user = await ctx.db.mutation.createUser({
            data: {
                ...args,
                password,
                permissions: { set: ['USER'] }
            }
        }, info
      );
      const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
      ctx.response.cookie('token', token, {
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 * 365 // 1 year cookie
      });
      return user;
    },
    async signin(parent, { email, password }, ctx, info) {
        const user = await ctx.db.query.user({ where: { email }});
        if(!user) {
            throw new Error(`No such user found for email ${email}`);
        }

        const valid = await bcrypt.compare(password, user.password);
        if(!valid) {
            throw new Error(`Invalid Password!`);
        }
        const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
        ctx.response.cookie('token', token, {
          httpOnly: true,
          maxAge: 1000 * 60 * 60 * 24 * 365 // 1 year cookie
        });
        return user;
    },
    signout(parent, args, ctx, info) {
        ctx.response.clearCookie('token');
        return { message: 'Goodbye!' };
    },
    async requestReset(parent, args, ctx, info) {
        const user = await ctx.db.query.user({ where: { email: args.email }});
        if(!user) {
            throw new Error(`No such user found for email ${args.email}`);
        }

        const resetToken = (await promisify(randomBytes)(20)).toString('hex');
        const resetTokenExpiry = Date.now() + (3600000 * 72) // 3 days from now
        const res = await ctx.db.mutation.updateUser({
            where: { email: args.email},
            data: { resetToken, resetTokenExpiry }
        });

                //Sending email through gmail with OAUTH2
                const oauth2Client = new OAuth2(
                    process.env.CLIENT_ID, // ClientID
                    process.env.CLIENT_SECRET, // Client Secret
                    "https://developers.google.com/oauthplayground" // Redirect URL
                );

                oauth2Client.setCredentials({
                    refresh_token: process.env.REFRESH_TOKEN
                });
                const tokens = await oauth2Client.refreshAccessToken()
                const accessToken = tokens.credentials.access_token

                const transport = nodemailer.createTransport({
                    service: "gmail",
                    auth: {
                         type: "OAuth2",
                         user: "shikha.das1@gmail.com",
                         clientId: process.env.CLIENT_ID,
                         clientSecret: process.env.CLIENT_SECRET,
                         refreshToken: process.env.REFRESH_TOKEN,
                         accessToken: accessToken
                    }
                  });

        const mailRes = await transport.sendMail({
            from: 'shikha.das1@gmail.com',
            to: user.email,
            subject: 'Your Password Reset Token',
            html: makeANiceEmail(`Your Password Reset token is
            \n\n
            <a href="${process.env.FRONTEND_URL}/reset?resetToken=${resetToken}">Click Here</a>`)
        });
        return { message: 'Thanks!' };
    },
    async resetPassword(parent, args, ctx, info) {
        if(args.password !== args.confirmPassword) {
            throw new Error("Your password don't match!");
        }

        const [user] = await ctx.db.query.users({
            where: {
                resetToken: args.resetToken,
                resetTokenExpiry_gte: Date.now() - (3600000 * 72)
            }
        });

        if(!user) {
            throw new Error("This token is either invalid or expired!");
        }

        const password = await bcrypt.hash(args.password, 15);

        const updatedUser = await ctx.db.mutation.updateUser({
            where: { email: user.email},
            data: { password, resetToken: null, resetTokenExpiry: null }
        });

        const token = jwt.sign({ userId: updatedUser.id }, process.env.APP_SECRET);

        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 24 * 365 // 1 year cookie
        });

        return updatedUser;
    },
    async updatePermissions(parent, args, ctx, info) {
        if(!ctx.request.userId) {
            throw new Error('You must be logged in!');
        }

        const currentUser = await ctx.db.query.user({
            where: {
                id: ctx.request.userId
            }
        }, info);

        hasPermission(currentUser, ['ADMIN', 'PERMISSIONUPDATE']);
        return ctx.db.mutation.updateUser(
            {
              data: {
                permissions: {
                  set: args.permissions,
                },
              },
              where: {
                id: args.userId,
              },
            },
            info
          );
    },
    async addToCart(parent, args, ctx, info) {
        // 1. Make sure they are signed in
        const { userId } = ctx.request;
        if (!userId) {
          throw new Error('You must be signed in soooon');
        }
        // 2. Query the users current cart
        const [existingCartItem] = await ctx.db.query.cartItems({
          where: {
            user: { id: userId },
            item: { id: args.id },
          },
        });
        // 3. Check if that item is already in their cart and increment by 1 if it is
        if (existingCartItem) {
          console.log('This item is already in their cart');
          return ctx.db.mutation.updateCartItem(
            {
              where: { id: existingCartItem.id },
              data: { quantity: existingCartItem.quantity + 1 },
            },
            info
          );
        }
        // 4. If its not, create a fresh CartItem for that user!
        return ctx.db.mutation.createCartItem(
          {
            data: {
              user: {
                connect: { id: userId },
              },
              item: {
                connect: { id: args.id },
              },
            },
          },
          info
        );
      },
      async removeFromCart(parent, args, ctx, info) {
        // 1. Find the cart item
        const cartItem = await ctx.db.query.cartItem(
            {
                where: {
                    id: args.id,
                },
            },
            `{ id, user { id }}`
        );
        // 1.5 Make sure we found an item
        if (!cartItem) throw new Error('No CartItem Found!');
        // 2. Make sure they own that cart item
        if (cartItem.user.id !== ctx.request.userId) {
            throw new Error('Cheatin huhhhh');
        }
        // 3. Delete that cart item
        return ctx.db.mutation.deleteCartItem(
            {
                where: { id: args.id },
            },
            info
        );
    },
    async createOrder(parent, args, ctx, info) {
        const { userId } = ctx.request;
        if (!userId) throw new Error('You must be signed in to complete this order.');

        const user = await ctx.db.query.user(
            { where: { id: userId } },
            `{
                id
                name
                email
                cart {
                    id
                    quantity
                    item { title price id image }
            }}`
        );
        const amount = user.cart.reduce(
            (tally, cartItem) => tally + cartItem.item.price * cartItem.quantity,
            0
        );
        console.log(`Going to charge for a total of ${amount}`);

        const orderItems = user.cart.map(cartItem => {
            const orderItem = {
                ...cartItem.item,
                quantity: cartItem.quantity,
                user: { connect: { id: userId } },
            };
            delete orderItem.id;
            return orderItem;
        });

        const order = await ctx.db.mutation.createOrder({
            data: {
                total: amount,
                items: { create: orderItems },
                user: { connect: { id: userId } },
            },
        });

        const cartItemIds = user.cart.map(cartItem => cartItem.id);
        await ctx.db.mutation.deleteManyCartItems({
            where: {
                id_in: cartItemIds,
            },
        });
        return order;
    }
};

module.exports = Mutations;
