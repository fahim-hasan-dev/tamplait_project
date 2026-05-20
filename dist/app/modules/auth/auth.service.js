"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthServices = exports.createUser = void 0;
const http_status_codes_1 = require("http-status-codes");
const user_model_1 = require("../user/user.model");
const ApiError_1 = __importDefault(require("../../../errors/ApiError"));
const user_1 = require("../../../enum/user");
const auth_helper_1 = require("./auth.helper");
const loginService_1 = require("./loginService");
const emailTemplate_1 = require("../../../shared/emailTemplate");
const emailHelper_1 = require("../../../helpers/emailHelper");
const jwtHelper_1 = require("../../../helpers/jwtHelper");
const config_1 = __importDefault(require("../../../config"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const crypto_1 = __importStar(require("../../../utils/crypto"));
const token_model_1 = require("../token/token.model");
const mongoose_1 = __importDefault(require("mongoose"));
const createUser = async (payload) => {
    var _a;
    payload.email = (_a = payload.email) === null || _a === void 0 ? void 0 : _a.toLowerCase().trim();
    const session = await mongoose_1.default.startSession();
    try {
        session.startTransaction();
        if (payload.role === user_1.USER_ROLES.ADMIN) {
            throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, `Admin account creation is not allowed.`);
        }
        // 1. Check if user already exists
        const isUserExist = await user_model_1.User.findOne({
            email: payload.email,
            status: { $nin: [user_1.USER_STATUS.DELETED] },
        }).session(session);
        if (isUserExist) {
            throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, `An account with this email already exists.`);
        }
        // 2. Generate OTP
        const otp = (0, crypto_1.generateOtp)();
        const otpExpiresIn = new Date(Date.now() + 5 * 60 * 1000);
        const authentication = {
            oneTimeCode: otp,
            expiresAt: otpExpiresIn,
            latestRequestAt: new Date(),
            requestCount: 1,
            authType: 'createAccount',
            restrictionLeftAt: null,
            resetPassword: false,
            wrongLoginAttempts: 0,
        };
        // 3. Send OTP email
        setTimeout(() => {
            const createAccountEmail = emailTemplate_1.emailTemplate.createAccount({
                name: `${payload.firstName} ${payload.lastName}`,
                email: payload.email,
                otp,
            });
            emailHelper_1.emailHelper.sendEmail(createAccountEmail);
        }, 0);
        // 4. Create User
        const user = await user_model_1.User.create([
            {
                ...payload,
                password: payload.password,
                authentication,
                role: payload.role || user_1.USER_ROLES.USER,
            },
        ], { session });
        if (!user[0])
            throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'Failed to create user.');
        const createdUser = user[0];
        // 5. Commit Transaction
        await session.commitTransaction();
        return createdUser._id;
    }
    catch (error) {
        // Rollback on error
        await session.abortTransaction();
        throw error;
    }
    finally {
        session.endSession();
    }
};
exports.createUser = createUser;
const login = async (payload) => {
    const { email, phone } = payload;
    const query = email ? { email: email.toLowerCase().trim() } : { phone: phone };
    const isUserExist = await user_model_1.User.findOne({
        ...query,
        status: { $in: [user_1.USER_STATUS.ACTIVE, user_1.USER_STATUS.RESTRICTED] },
    })
        .select('+password +authentication')
        .lean();
    if (!isUserExist) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, `No account found with this ${email ? 'email' : 'phone'}`);
    }
    const result = await loginService_1.AuthCommonServices.handleLoginLogic(payload, isUserExist);
    return result;
};
const adminLogin = async (payload) => {
    const { email, phone } = payload;
    const query = email ? { email: email.trim().toLowerCase() } : { phone: phone };
    const isUserExist = await user_model_1.User.findOne({
        ...query,
    })
        .select('+password +authentication')
        .lean();
    if (!isUserExist) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, `No account found with this ${email ? 'email' : 'phone'}`);
    }
    if (isUserExist.role !== user_1.USER_ROLES.ADMIN) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'You are not authorized to login as admin');
    }
    const isPasswordMatch = await auth_helper_1.AuthHelper.isPasswordMatched(payload.password, isUserExist.password);
    if (!isPasswordMatch) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.UNAUTHORIZED, 'Please try again with correct credentials.');
    }
    // Create tokens
    const tokens = auth_helper_1.AuthHelper.createToken(isUserExist._id, isUserExist.role, `${isUserExist.firstName} ${isUserExist.lastName}`, isUserExist.email);
    return (0, loginService_1.authResponse)(http_status_codes_1.StatusCodes.OK, `Welcome back ${isUserExist.firstName}`, isUserExist.role, tokens.accessToken, tokens.refreshToken);
};
const forgetPassword = async (email, phone) => {
    const query = email
        ? { email: email.toLocaleLowerCase().trim() }
        : { phone: phone };
    const isUserExist = await user_model_1.User.findOne({
        ...query,
        status: { $in: [user_1.USER_STATUS.ACTIVE, user_1.USER_STATUS.RESTRICTED] },
    });
    if (!isUserExist) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'No account found with this email or phone');
    }
    const otp = (0, crypto_1.generateOtp)();
    const authentication = {
        resetPassword: true,
        oneTimeCode: otp,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        latestRequestAt: new Date(),
        requestCount: 1,
        authType: 'resetPassword',
        restrictionLeftAt: null,
        wrongLoginAttempts: 0,
    };
    await user_model_1.User.findByIdAndUpdate(isUserExist._id, {
        $set: { authentication: authentication },
    }, { new: true });
    // Send OTP to user
    if (email) {
        const forgetPasswordEmailTemplate = emailTemplate_1.emailTemplate.resetPassword({
            name: `${isUserExist.firstName} ${isUserExist.lastName}`,
            email: isUserExist.email,
            otp,
        });
        setTimeout(() => {
            emailHelper_1.emailHelper.sendEmail(forgetPasswordEmailTemplate);
        }, 0);
    }
    return 'OTP sent successfully.';
};
const resetPassword = async (resetToken, payload) => {
    const { newPassword, confirmPassword } = payload;
    if (newPassword !== confirmPassword) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'Passwords do not match');
    }
    const isTokenExist = await token_model_1.Token.findOne({ token: resetToken }).lean();
    if (!isTokenExist) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, "You don't have authorization to reset your password, please verify your account first.");
    }
    const isUserExist = await user_model_1.User.findById(isTokenExist.user)
        .select('+authentication')
        .lean();
    console.log(isUserExist);
    if (!isUserExist) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'Requested user not found, please try again or contact support.');
    }
    const { authentication } = isUserExist;
    if (!(authentication === null || authentication === void 0 ? void 0 : authentication.resetPassword)) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'You don\'t have permission to change the password. Please click again to "Forgot Password"');
    }
    const isTokenValid = (isTokenExist === null || isTokenExist === void 0 ? void 0 : isTokenExist.expireAt) > new Date();
    if (!isTokenValid) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'Your reset token has expired, please try again.');
    }
    const hashPassword = await bcrypt_1.default.hash(newPassword, Number(config_1.default.bcrypt_salt_rounds));
    const updatedUserData = {
        password: hashPassword,
        authentication: {
            resetPassword: false,
            oneTimeCode: '',
            expiresAt: null,
            latestRequestAt: new Date(),
            requestCount: 0,
            restrictionLeftAt: null,
            wrongLoginAttempts: 0,
        },
    };
    await user_model_1.User.findByIdAndUpdate(isUserExist._id, { $set: updatedUserData }, { new: true });
    return { message: 'Password reset successfully' };
};
const verifyAccount = async (email, onetimeCode) => {
    //verify fo new user
    if (!onetimeCode) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'OTP is required.');
    }
    const isUserExist = await user_model_1.User.findOne({
        email: email.toLowerCase().trim(),
        status: { $nin: [user_1.USER_STATUS.DELETED] },
    })
        .select('+password +authentication')
        .lean();
    if (!isUserExist) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, `No account found with this ${email}, please register first.`);
    }
    const { authentication } = isUserExist;
    //check the otp
    if ((authentication === null || authentication === void 0 ? void 0 : authentication.oneTimeCode) !== onetimeCode) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'Invalid OTP, please try again.');
    }
    const currentDate = new Date();
    if ((authentication === null || authentication === void 0 ? void 0 : authentication.expiresAt) < currentDate) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'OTP has expired, please try again.');
    }
    //either newly created user or existing user
    if (!isUserExist.verified) {
        await user_model_1.User.findByIdAndUpdate(isUserExist._id, { $set: { verified: true } }, { new: true });
        const tokens = auth_helper_1.AuthHelper.createToken(isUserExist._id, isUserExist.role, isUserExist.firstName + ' ' + isUserExist.lastName, isUserExist.email);
        const userInfo = {
            id: isUserExist._id,
            role: isUserExist.role,
            name: `${isUserExist.firstName} ${isUserExist.lastName}`,
            email: isUserExist.email,
            image: isUserExist.image,
        };
        return (0, loginService_1.authResponse)(http_status_codes_1.StatusCodes.OK, `Welcome ${isUserExist.firstName} ${isUserExist.lastName} to our platform.`, undefined, tokens.accessToken, tokens.refreshToken, undefined, userInfo);
    }
    else {
        await user_model_1.User.findByIdAndUpdate(isUserExist._id, {
            $set: {
                authentication: {
                    oneTimeCode: '',
                    expiresAt: null,
                    latestRequestAt: null,
                    requestCount: 0,
                    authType: '',
                    resetPassword: true,
                },
            },
        }, { new: true });
        const token = await token_model_1.Token.create({
            token: (0, crypto_1.default)(),
            user: isUserExist._id,
            expireAt: new Date(Date.now() + 5 * 60 * 1000), // 15 minutes
        });
        console.log(token.token);
        if (!token) {
            throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, ' please try again. or contact support.');
        }
        return (0, loginService_1.authResponse)(http_status_codes_1.StatusCodes.OK, 'OTP verified successfully, please reset your password.', undefined, undefined, undefined, token.token);
    }
};
const getAccessToken = async (token) => {
    if (!token) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.UNAUTHORIZED, 'Refresh Token is required');
    }
    try {
        const decodedToken = jwtHelper_1.jwtHelper.verifyToken(token, config_1.default.jwt.jwt_refresh_secret);
        const { userId, role } = decodedToken;
        const tokens = auth_helper_1.AuthHelper.createToken(userId, role, decodedToken.name, decodedToken.email);
        return {
            accessToken: tokens.accessToken,
        };
    }
    catch (error) {
        if (error instanceof Error && error.name === 'TokenExpiredError') {
            throw new ApiError_1.default(http_status_codes_1.StatusCodes.UNAUTHORIZED, 'Refresh Token has expired');
        }
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.FORBIDDEN, 'Invalid Refresh Token');
    }
};
const resendOtpToPhoneOrEmail = async (authType, email, phone) => {
    const query = email ? { email: email } : { phone: phone };
    const isUserExist = await user_model_1.User.findOne({
        ...query,
        status: { $in: [user_1.USER_STATUS.ACTIVE, user_1.USER_STATUS.RESTRICTED] },
    }).select('+authentication');
    if (!isUserExist) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, `No account found with this ${email ? 'email' : 'phone'}`);
    }
    // Check the request count
    const { authentication } = isUserExist;
    if ((authentication === null || authentication === void 0 ? void 0 : authentication.requestCount) >= 5) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'You have exceeded the maximum number of requests. Please try again later.');
    }
    const otp = (0, crypto_1.generateOtp)();
    const updatedAuthentication = {
        ...authentication,
        oneTimeCode: otp,
        latestRequestAt: new Date(),
        requestCount: (authentication === null || authentication === void 0 ? void 0 : authentication.requestCount) + 1,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
        authType: authType,
    };
    // Send OTP to user
    if (email) {
        const forgetPasswordEmailTemplate = emailTemplate_1.emailTemplate.resendOtp({
            email: isUserExist.email,
            name: `${isUserExist.firstName} ${isUserExist.lastName}`,
            otp,
            type: authType,
        });
        await user_model_1.User.findByIdAndUpdate(isUserExist._id, {
            $set: { authentication: updatedAuthentication },
        }, { new: true });
        await emailHelper_1.emailHelper.sendEmail(forgetPasswordEmailTemplate);
    }
    if (phone) {
        // Implement this feature using aws sns
        await user_model_1.User.findByIdAndUpdate(isUserExist._id, {
            $set: { authentication: updatedAuthentication },
        }, { new: true });
    }
};
const deleteAccount = async (user, password) => {
    const { authId } = user;
    const isUserExist = await user_model_1.User.findById(authId).select('+password');
    if (!isUserExist) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'Failed to delete account. Please try again.');
    }
    if (isUserExist.status === user_1.USER_STATUS.DELETED) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'Requested user is already deleted.');
    }
    const isPasswordMatched = await bcrypt_1.default.compare(password, isUserExist.password);
    if (!isPasswordMatched) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'Please provide a valid password to delete your account.');
    }
    const deletedData = await user_model_1.User.findByIdAndUpdate(authId, {
        $set: { status: user_1.USER_STATUS.DELETED },
    });
    return {
        status: http_status_codes_1.StatusCodes.OK,
        message: 'Account deleted successfully.',
        deletedData,
    };
};
const resendOtp = async (email, authType) => {
    const isUserExist = await user_model_1.User.findOne({
        email: email.toLowerCase().trim(),
        status: { $in: [user_1.USER_STATUS.ACTIVE, user_1.USER_STATUS.RESTRICTED] },
    }).select('+authentication');
    if (!isUserExist) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, `No account found with this ${email}, please try again.`);
    }
    const { authentication } = isUserExist;
    const otp = (0, crypto_1.generateOtp)();
    const authenticationPayload = {
        ...authentication,
        oneTimeCode: otp,
        latestRequestAt: new Date(),
        requestCount: (authentication === null || authentication === void 0 ? void 0 : authentication.requestCount) + 1,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
    };
    if (authenticationPayload.requestCount >= 5) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'You have exceeded the maximum number of requests. Please try again later.');
    }
    await user_model_1.User.findByIdAndUpdate(isUserExist._id, {
        $set: { authentication: authenticationPayload },
    }, { new: true });
    // Send OTP to user
    if (email) {
        const forgetPasswordEmailTemplate = emailTemplate_1.emailTemplate.resendOtp({
            email: email,
            name: `${isUserExist.firstName} ${isUserExist.lastName}`,
            otp,
            type: authType,
        });
        setTimeout(() => {
            emailHelper_1.emailHelper.sendEmail(forgetPasswordEmailTemplate);
        }, 0);
    }
    return 'OTP sent successfully.';
};
const changePassword = async (user, currentPassword, newPassword) => {
    // Find the user with password field
    const isUserExist = await user_model_1.User.findById(user.authId)
        .select('+password')
        .lean();
    if (!isUserExist) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.NOT_FOUND, 'User not found');
    }
    // Check if current password matches
    const isPasswordMatch = await auth_helper_1.AuthHelper.isPasswordMatched(currentPassword, isUserExist.password);
    if (!isPasswordMatch) {
        throw new ApiError_1.default(http_status_codes_1.StatusCodes.BAD_REQUEST, 'Current password is incorrect');
    }
    // Hash the new password
    const hashedPassword = await bcrypt_1.default.hash(newPassword, Number(config_1.default.bcrypt_salt_rounds));
    // Update the password
    await user_model_1.User.findByIdAndUpdate(user.authId, { password: hashedPassword }, { new: true });
    return { message: 'Password changed successfully' };
};
exports.AuthServices = {
    forgetPassword,
    resetPassword,
    verifyAccount,
    login,
    getAccessToken,
    resendOtpToPhoneOrEmail,
    deleteAccount,
    resendOtp,
    changePassword,
    createUser: exports.createUser,
    adminLogin
};
