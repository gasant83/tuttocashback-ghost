const moment = require('moment');
const htmlToPlaintext = require('@tryghost/html-to-plaintext');
const emailService = require('../email-service');
const CommentsServiceEmailRenderer = require('./CommentsServiceEmailRenderer');
const {t} = require('../i18n');

class CommentsServiceEmails {
    constructor({config, logging, models, mailer, settingsCache, settingsHelpers, urlService, urlUtils}) {
        this.config = config;
        this.logging = logging;
        this.models = models;
        this.mailer = mailer;
        this.settingsCache = settingsCache;
        this.settingsHelpers = settingsHelpers;
        this.urlService = urlService;
        this.urlUtils = urlUtils;
        this.commentsServiceEmailRenderer = new CommentsServiceEmailRenderer({t});
    }

    async notifyPostAuthors(comment) {
        const post = await this.models.Post.findOne({id: comment.get('post_id')}, {withRelated: ['authors']});
        const member = await this.models.Member.findOne({id: comment.get('member_id')});

        for (const author of post.related('authors')) {
            if (!author.get('comment_notifications')) {
                continue;
            }

            const to = author.get('email');
            const subject = '💬 New comment on your post: ' + post.get('title');

            const memberName = member.get('name') || 'Anonymous';

            const templateData = {
                siteTitle: this.settingsCache.get('title'),
                siteUrl: this.urlUtils.getSiteUrl(),
                siteDomain: this.siteDomain,
                postTitle: post.get('title'),
                postUrl: this.urlService.getUrlByResourceId(post.get('id'), {absolute: true}),
                commentHtml: comment.get('html'),
                commentDate: moment(comment.get('created_at')).tz(this.settingsCache.get('timezone')).format('D MMM YYYY'),
                memberName: memberName,
                memberExpertise: member.get('expertise'),
                memberInitials: this.extractInitials(memberName),
                accentColor: this.settingsCache.get('accent_color'),
                fromEmail: this.notificationFromAddress,
                toEmail: to,
                staffUrl: this.urlUtils.urlJoin(this.urlUtils.urlFor('admin', true), '#', `/settings/staff/${author.get('slug')}`)
            };

            const {
                html,
                text
            } = await this.commentsServiceEmailRenderer.renderEmailTemplate('new-comment', templateData);

            await this.sendMail({
                to,
                subject,
                html,
                text
            });
        }
    }

    async notifyParentCommentAuthor(reply, {type = 'parent'} = {}) {
        let parent;
        if (type === 'in_reply_to') {
            parent = await this.models.Comment.findOne({id: reply.get('in_reply_to_id')});
        } else {
            parent = await this.models.Comment.findOne({id: reply.get('parent_id')});
        }
        const parentMember = parent.related('member');

        if (parent?.get('status') !== 'published' || !parentMember.get('enable_comment_notifications')) {
            return;
        }

        const memberId = reply.get('member_id');

        // Don't send a notification if you reply to your own comment
        if (parentMember.id === memberId) {
            return;
        }

        const parentMemberEmail = parentMember.get('email');
        const subject = '↪️ ' + t(`New reply to your comment on {siteTitle}`, {
            siteTitle: this.settingsCache.get('title'),
            interpolation: {escapeValue: false}
        });

        const post = await this.models.Post.findOne({id: reply.get('post_id')});
        const member = await this.models.Member.findOne({id: memberId});

        const memberName = member.get('name') || 'Anonymous';

        const templateData = {
            siteTitle: this.settingsCache.get('title'),
            siteUrl: this.urlUtils.getSiteUrl(),
            siteDomain: this.siteDomain,
            postTitle: post.get('title'),
            postUrl: this.urlService.getUrlByResourceId(post.get('id'), {absolute: true}),
            replyHtml: reply.get('html'),
            replyDate: moment(reply.get('created_at')).tz(this.settingsCache.get('timezone')).format('D MMM YYYY'),
            memberName: memberName,
            memberExpertise: member.get('expertise'),
            memberInitials: this.extractInitials(memberName),
            accentColor: this.settingsCache.get('accent_color'),
            fromEmail: this.notificationFromAddress,
            toEmail: parentMemberEmail,
            profileUrl: emailService.renderer.createUnsubscribeUrl(parentMember.get('uuid'), {comments: true})
        };

        const {
            html,
            text
        } = await this.commentsServiceEmailRenderer.renderEmailTemplate('new-comment-reply', templateData);

        return this.sendMail({
            to: parentMemberEmail,
            subject,
            html,
            text
        });
    }

    /**
     * Send an email to notify the owner of the site that a comment has been reported by a member
     * @param {*} comment The comment model that has been reported
     * @param {*} reporter The member object who reported this comment
     */
    async notifyReport(comment, reporter) {
        const post = await this.models.Post.findOne({id: comment.get('post_id')}, {withRelated: ['authors']});
        const member = await this.models.Member.findOne({id: comment.get('member_id')});
        const owner = await this.models.User.getOwnerUser();

        // For now we only send the report to the owner
        const to = owner.get('email');
        const subject = '🚩 A comment has been reported on your post';

        const memberName = member.get('name') || 'Anonymous';

        const templateData = {
            siteTitle: this.settingsCache.get('title'),
            siteUrl: this.urlUtils.getSiteUrl(),
            siteDomain: this.siteDomain,
            postTitle: post.get('title'),
            postUrl: this.urlService.getUrlByResourceId(post.get('id'), {absolute: true}),
            commentHtml: comment.get('html'),
            commentText: htmlToPlaintext.comment(comment.get('html')),
            commentDate: moment(comment.get('created_at')).tz(this.settingsCache.get('timezone')).format('D MMM YYYY'),

            reporterName: reporter.name,
            reporterEmail: reporter.email,
            reporter: reporter.name ? `${reporter.name} (${reporter.email})` : reporter.email,

            memberName: memberName,
            memberEmail: member.get('email'),
            memberExpertise: member.get('expertise'),
            memberInitials: this.extractInitials(memberName),
            accentColor: this.settingsCache.get('accent_color'),
            fromEmail: this.notificationFromAddress,
            toEmail: to,
            staffUrl: this.urlUtils.urlJoin(this.urlUtils.urlFor('admin', true), '#', `/settings/staff/${owner.get('slug')}`)
        };

        const {html, text} = await this.commentsServiceEmailRenderer.renderEmailTemplate('report', templateData);

        await this.sendMail({
            to,
            subject,
            html,
            text
        });
    }

    // Utils

    get siteDomain() {
        const [, siteDomain] = this.urlUtils.getSiteUrl()
            .match(new RegExp('^https?://([^/:?#]+)(?:[/:?#]|$)', 'i'));

        return siteDomain;
    }

    get notificationFromAddress() {
        return this.settingsHelpers.getMembersSupportAddress();
    }

    extractInitials(name = '') {
        const names = name.split(' ');
        const initials = names.length > 1 ? [names[0][0], names[names.length - 1][0]] : [names[0][0]];
        return initials.join('').toUpperCase();
    }

    async sendMail(message) {
        if (process.env.NODE_ENV !== 'production') {
            this.logging.warn(message.text);
        }

        let msg = Object.assign({
            from: this.notificationFromAddress,
            forceTextContent: true
        }, message);

        return this.mailer.send(msg);
    }
}

module.exports = CommentsServiceEmails;
